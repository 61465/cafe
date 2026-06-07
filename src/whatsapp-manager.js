/**
 * WhatsApp Manager — إدارة جلسات Baileys لجميع المتاجر
 * كل متجر = جلسة منفصلة محفوظة في data/sessions/{storeId}/
 */

const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  isJidBroadcast,
  makeInMemoryStore,
} = require("@whiskeysockets/baileys");
const { Boom } = require("@hapi/boom");
const pino   = require("pino");
const fs     = require("fs");
const path   = require("path");

const DATA_DIR    = path.join(__dirname, "..", "data");
const SESSION_DIR = path.join(DATA_DIR, "sessions");

// ─── Logger (silent in production) ───────────────────────────────────────────
const logger = pino({ level: "silent" });

// ─── Session state ────────────────────────────────────────────────────────────
// storeId → { sock, status, phone, pairingCode, pairingCodeExp, reconnectTimer, ttlTimer }
const sessions = new Map();

const TRY_SLOT_PATTERN = /^(try_\d+|owner_try)$/;
const TRY_TTL_MS = 45 * 60 * 1000; // 45 minutes

function scheduleTryTTL(storeId) {
  if (!TRY_SLOT_PATTERN.test(storeId)) return;
  const session = sessions.get(storeId);
  if (!session) return;
  if (session.ttlTimer) clearTimeout(session.ttlTimer);
  session.ttlTimer = setTimeout(async () => {
    console.log(`⏰ [${storeId}] TTL expired — clearing slot`);
    const s = sessions.get(storeId);
    if (!s) return;
    if (s.reconnectTimer) clearTimeout(s.reconnectTimer);
    try { await s.sock?.logout(); } catch {}
    const sessionPath = path.join(SESSION_DIR, storeId);
    try { fs.rmSync(sessionPath, { recursive: true, force: true }); } catch {}
    sessions.delete(storeId);
  }, TRY_TTL_MS);
}

// ─── Global message handler (set by server.js) ───────────────────────────────
let globalMessageHandler = null;

function setMessageHandler(fn) {
  globalMessageHandler = fn;
}

// ─── Init / connect a session ─────────────────────────────────────────────────
async function initSession(storeId) {
  // Cleanup any existing reconnect timer
  const existing = sessions.get(storeId);
  if (existing?.reconnectTimer) clearTimeout(existing.reconnectTimer);

  const sessionPath = path.join(SESSION_DIR, storeId);
  fs.mkdirSync(sessionPath, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
  const { version }          = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth:              state,
    logger,
    printQRInTerminal: false,
    browser:           ["NexusBot", "Chrome", "1.0.0"],
    keepAliveIntervalMs:  30_000,
    connectTimeoutMs:     60_000,
    retryRequestDelayMs:  500,
    markOnlineOnConnect:  true,
    getMessage: async () => ({ conversation: "" }),
  });

  // Update or create session entry
  sessions.set(storeId, {
    sock,
    status:          "connecting",
    phone:           existing?.phone || null,
    pairingCode:     null,
    pairingCodeExp:  null,
    reconnectTimer:  null,
  });

  // ── Save credentials on update ──────────────────────────────────────────────
  sock.ev.on("creds.update", saveCreds);

  // ── Connection lifecycle ────────────────────────────────────────────────────
  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;
    const session = sessions.get(storeId);
    if (!session) return;

    if (qr) {
      session.qr     = qr;
      session.status = "qr";
      console.log(`📱 [${storeId}] QR code ready`);
    }

    if (connection === "open") {
      session.status      = "open";
      session.pairingCode = null;
      session.qr          = null;
      console.log(`✅ [${storeId}] WhatsApp connected`);
      scheduleTryTTL(storeId);
    }

    if (connection === "close") {
      const statusCode = new Boom(lastDisconnect?.error)?.output?.statusCode;
      console.log(`⚠️  [${storeId}] Disconnected — reason: ${statusCode}`);

      if (statusCode === DisconnectReason.loggedOut) {
        session.status = "disconnected";
        try { fs.rmSync(sessionPath, { recursive: true, force: true }); } catch {}
        fs.mkdirSync(sessionPath, { recursive: true });
        console.log(`🗑️  [${storeId}] Session wiped (logged out)`);
      } else {
        session.status = "reconnecting";
        session.reconnectTimer = setTimeout(() => initSession(storeId), 5_000);
      }
    }
  });

  // ── Incoming messages ───────────────────────────────────────────────────────
  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") {
      if (/^try_/.test(storeId)) console.log(`[${storeId}] upsert type="${type}" (skipped)`);
      return;
    }

    for (const msg of messages) {
      try {
        if (/^try_/.test(storeId)) {
          console.log(`[${storeId}] raw msg: fromMe=${msg.key.fromMe} jid=${msg.key.remoteJid} types=${Object.keys(msg.message||{}).join(",")}`);
        }
        if (msg.key.fromMe)                        continue;
        if (!msg.key.remoteJid)                    continue;
        if (isJidBroadcast(msg.key.remoteJid))     continue;
        if (msg.key.remoteJid.endsWith("@g.us"))   continue;
        // @lid = WhatsApp privacy JID (newer iOS/Android) — keep, don't filter

        const from = msg.key.remoteJid
          .replace("@s.whatsapp.net", "")
          .replace("@lid", "@lid"); // preserve @lid so we can reply back

        // Extract text — prefer IDs over display text so bot logic matches correctly
        const m = msg.message || {};
        let interactiveId = "";
        try {
          const raw = m.interactiveResponseMessage?.nativeFlowResponseMessage?.paramsJson;
          if (raw) interactiveId = JSON.parse(raw)?.id || "";
        } catch {}
        const text =
          m.conversation ||
          m.extendedTextMessage?.text ||
          m.buttonsResponseMessage?.selectedButtonId ||
          m.listResponseMessage?.singleSelectReply?.selectedRowId ||
          m.listResponseMessage?.title ||
          m.templateButtonReplyMessage?.selectedId ||
          interactiveId ||
          "";

        console.log(`📨 [${storeId}] from=${from} text="${text}"`);
        if (!text && msg.message?.locationMessage) {
          const { degreesLatitude: lat, degreesLongitude: lng, name, address } = msg.message.locationMessage;
          const label   = name || address || `${lat},${lng}`;
          const mapsUrl = `https://maps.google.com/?q=${lat},${lng}`;
          const locText = `📍 ${label}\n${mapsUrl}`;
          if (globalMessageHandler) await globalMessageHandler(storeId, from, locText, msg);
          continue;
        }

        if (!text) continue;

        if (globalMessageHandler) {
          await globalMessageHandler(storeId, from, text.trim(), msg);
        }
      } catch (err) {
        console.error(`❌ [${storeId}] Error processing message:`, err.message);
      }
    }
  });

  return sock;
}

// ─── Request pairing code ─────────────────────────────────────────────────────
async function requestPairingCode(storeId, phoneNumber) {
  // Clean phone number
  const phone = phoneNumber.replace(/[\s\+\-\(\)]/g, "");

  let session = sessions.get(storeId);
  if (!session || session.status === "disconnected") {
    await initSession(storeId);
    session = sessions.get(storeId);
    // Wait a bit for socket to be ready
    await new Promise(r => setTimeout(r, 2_000));
  }

  const { sock } = session;
  if (!sock) throw new Error("Socket not initialized");

  const code = await sock.requestPairingCode(phone);
  session.phone          = phone;
  session.pairingCode    = code;
  session.pairingCodeExp = Date.now() + 60_000; // expires in 60s
  session.status         = "pairing";

  return code;
}

// ─── Send interactive buttons ─────────────────────────────────────────────────
async function sendButtons(storeId, to, { body, buttons, footer }) {
  const session = sessions.get(storeId);
  if (!session || session.status !== "open") return;
  const jid  = to.includes("@") ? to : `${to}@s.whatsapp.net`;
  const safe = buttons.slice(0, 3);

  // listMessage — native WhatsApp "tap to select" list, most reliable on personal accounts
  try {
    await session.sock.sendMessage(jid, {
      listMessage: {
        title:       "",
        description: body,
        buttonText:  "اختر ▼",
        listType:    1,
        sections: [{
          title: "الخيارات",
          rows:  safe.map(b => ({
            rowId:       b.id,
            title:       b.title,
            description: "",
          })),
        }],
      },
    });
    return;
  } catch {}

  // Fallback: numbered text (user types 1/2/3)
  const nums = ["1️⃣","2️⃣","3️⃣"];
  const opts = safe.map((b, i) => `${nums[i]} ${b.title}`).join("\n");
  await session.sock.sendMessage(jid, {
    text: body + "\n\n" + opts + (footer ? "\n\n_" + footer + "_" : ""),
  });
}

// ─── Send list message ────────────────────────────────────────────────────────
async function sendList(storeId, to, { body, sections, footer, buttonText }) {
  const session = sessions.get(storeId);
  if (!session || session.status !== "open") return;
  const jid  = to.includes("@") ? to : `${to}@s.whatsapp.net`;

  // listMessage — native WhatsApp list picker, most reliable on personal accounts
  try {
    await session.sock.sendMessage(jid, {
      listMessage: {
        title:       "",
        description: body,
        buttonText:  buttonText || "اعرض الخيارات ▼",
        listType:    1,
        sections: sections.map(s => ({
          title: s.title,
          rows:  s.rows.map(r => ({
            rowId:       r.id,
            title:       r.title,
            description: r.description || "",
          })),
        })),
        ...(footer ? { footerText: footer } : {}),
      },
    });
    return;
  } catch {}

  // Fallback: numbered text
  const rows = sections.flatMap(s => s.rows);
  const nums = ["1️⃣","2️⃣","3️⃣","4️⃣","5️⃣","6️⃣","7️⃣","8️⃣","9️⃣","🔟"];
  const opts = rows.map((r, i) => `${nums[i] || `${i+1}.`} ${r.title}`).join("\n");
  await session.sock.sendMessage(jid, {
    text: body + "\n\n" + opts + (footer ? "\n\n_" + footer + "_" : ""),
  });
}

// ─── Send a text message ──────────────────────────────────────────────────────
async function sendMessage(storeId, to, text) {
  const session = sessions.get(storeId);
  if (!session) throw new Error(`No session for store: ${storeId}`);
  if (session.status !== "open") throw new Error(`Store ${storeId} not connected (${session.status})`);

  const jid = to.includes("@") ? to : `${to}@s.whatsapp.net`;
  await session.sock.sendMessage(jid, { text });
}

// ─── Send image (supports Buffer, file path, or HTTP URL) ─────────────────────
async function sendImage(storeId, to, source, caption = "") {
  const session = sessions.get(storeId);
  if (!session || session.status !== "open") throw new Error("Not connected");

  const jid = to.includes("@") ? to : `${to}@s.whatsapp.net`;
  let buffer;
  if (Buffer.isBuffer(source)) {
    buffer = source;
  } else if (source && source.startsWith("http")) {
    const https = require("https");
    const http  = require("http");
    buffer = await new Promise((resolve, reject) => {
      const mod = source.startsWith("https") ? https : http;
      mod.get(source, { timeout: 10000 }, res => {
        const chunks = [];
        res.on("data", c => chunks.push(c));
        res.on("end", () => resolve(Buffer.concat(chunks)));
        res.on("error", reject);
      }).on("error", reject);
    });
  } else {
    buffer = fs.readFileSync(source);
  }
  await session.sock.sendMessage(jid, { image: buffer, caption });
}

// ─── Get session status ───────────────────────────────────────────────────────
function getStatus(storeId) {
  const s = sessions.get(storeId);
  if (!s) return { status: "disconnected", phone: null, pairingCode: null, qr: null };
  const code = s.pairingCode && s.pairingCodeExp > Date.now() ? s.pairingCode : null;
  return { status: s.status, phone: s.phone, pairingCode: code, qr: s.qr || null };
}

async function resetSession(storeId) {
  const session = sessions.get(storeId);
  if (session) {
    if (session.reconnectTimer) clearTimeout(session.reconnectTimer);
    if (session.ttlTimer)       clearTimeout(session.ttlTimer);
    try { await session.sock?.logout(); } catch {}
    const sessionPath = path.join(SESSION_DIR, storeId);
    try { fs.rmSync(sessionPath, { recursive: true, force: true }); } catch {}
    sessions.delete(storeId);
  }
  await initSession(storeId);
}

// ─── Disconnect a session ─────────────────────────────────────────────────────
async function disconnectSession(storeId) {
  const session = sessions.get(storeId);
  if (!session) return;
  if (session.reconnectTimer) clearTimeout(session.reconnectTimer);
  if (session.ttlTimer)       clearTimeout(session.ttlTimer);
  try { await session.sock?.logout(); } catch {}
  sessions.delete(storeId);
  const sessionPath = path.join(SESSION_DIR, storeId);
  try { fs.rmSync(sessionPath, { recursive: true, force: true }); } catch {}
  console.log(`🔌 [${storeId}] Session disconnected and wiped`);
}

// ─── Boot all sessions from stores.json ──────────────────────────────────────
async function bootAllSessions(storesJson) {
  fs.mkdirSync(SESSION_DIR, { recursive: true });
  const storeIds = storesJson
    .filter(s => s.active && s.subscriptionStatus === "active")
    .map(s => s.id);

  // Boot platform/lead sessions if credentials exist (try_* are claimed on-demand)
  const specials = ["platform", "lead"];
  for (const special of specials) {
    const sessionPath = path.join(SESSION_DIR, special);
    if (fs.existsSync(path.join(sessionPath, "creds.json"))) {
      storeIds.push(special);
    }
  }

  console.log(`🚀 Booting ${storeIds.length} WhatsApp session(s)...`);
  for (const id of storeIds) {
    try { await initSession(id); } catch (e) {
      console.error(`❌ Failed to boot session [${id}]:`, e.message);
    }
  }
}

// ─── List all session IDs ─────────────────────────────────────────────────────
function listSessions() {
  return [...sessions.entries()].map(([id, s]) => ({
    storeId: id,
    status:  s.status,
    phone:   s.phone,
  }));
}

module.exports = {
  initSession,
  requestPairingCode,
  resetSession,
  sendMessage,
  sendButtons,
  sendList,
  sendImage,
  getStatus,
  disconnectSession,
  bootAllSessions,
  listSessions,
  setMessageHandler,
};
