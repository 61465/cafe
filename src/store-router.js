/**
 * Store Admin Router — واجهة كل عميل لإدارة متجره
 * Routes: /store/*
 * Auth: ownerPhone + storePassword → x-store-token header
 */

const express      = require("express");
const crypto       = require("crypto");
const fs           = require("fs");
const path         = require("path");
const { generateInvoiceImage } = require("./invoice-image");
const { generateMenuImage }    = require("./menu-image");
const { getPlan, getPlanFeatures } = require("./plans");
const firestoreAuth = require("./firestore-auth");
const waMgr        = require("./whatsapp-manager");

const router    = express.Router();
const DATA_DIR  = path.join(__dirname, "..", "data");
const STORES_FILE = path.join(DATA_DIR, "stores.json");

// ─── In-memory sessions: token → { storeId, createdAt } ─────────────────────
const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours
const sessions = new Map();

// Clean expired sessions every hour
setInterval(() => {
  const cutoff = Date.now() - SESSION_TTL_MS;
  for (const [token, val] of sessions) {
    if (val.createdAt < cutoff) sessions.delete(token);
  }
}, 60 * 60 * 1000);

// ─── Storage helpers ──────────────────────────────────────────────────────────
function readStores() {
  try { return JSON.parse(fs.readFileSync(STORES_FILE, "utf8")); }
  catch { return { stores: [] }; }
}

function writeStores(data) {
  fs.writeFileSync(STORES_FILE, JSON.stringify(data, null, 2));
}

function getStore(id) {
  return readStores().stores.find(s => s.id === id) || null;
}

function updateStore(id, updates) {
  const data = readStores();
  const idx  = data.stores.findIndex(s => s.id === id);
  if (idx === -1) return null;
  data.stores[idx] = { ...data.stores[idx], ...updates, id };
  writeStores(data);
  return data.stores[idx];
}

function readOrders(storeId) {
  const file = storeId === "nakheel_001"
    ? path.join(DATA_DIR, "orders.jsonl")
    : path.join(DATA_DIR, `orders_${storeId}.jsonl`);
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8")
    .split("\n").filter(Boolean)
    .map(l => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);
}

// ─── Auth middleware ──────────────────────────────────────────────────────────
function auth(req, res, next) {
  const token = req.headers["x-store-token"];
  const entry = sessions.get(token);
  if (!token || !entry) return res.status(401).json({ error: "يرجى تسجيل الدخول" });
  if (Date.now() - entry.createdAt > SESSION_TTL_MS) {
    sessions.delete(token);
    return res.status(401).json({ error: "انتهت الجلسة، يرجى تسجيل الدخول مجدداً" });
  }
  req.storeId = entry.storeId;
  next();
}

// ─── Login / Logout ───────────────────────────────────────────────────────────
router.post("/store/login", async (req, res) => {
  const { phone, password } = req.body || {};
  if (!phone || !password) return res.status(400).json({ error: "رقم الجوال وكلمة المرور مطلوبان" });

  let storeId, storeName, subscriptionStatus;

  // ── Try Firestore first (phone+password check) ───────────────────────────────
  if (firestoreAuth.isReady()) {
    try {
      const result = await firestoreAuth.loginStoreAdmin(phone, password);
      if (result) storeId = result.storeId;
    } catch (e) {
      console.warn("Firestore login error:", e.message);
    }
  }

  // ── Fallback: stores.json (plain-text password) ──────────────────────────────
  if (!storeId) {
    const { stores } = readStores();
    const store = stores.find(
      s => s.ownerPhone === String(phone).trim() && s.storePassword === String(password).trim()
    );
    if (store) storeId = store.id;
  }

  if (!storeId) return res.status(403).json({ error: "رقم الجوال أو كلمة المرور خاطئة" });

  // ── Always read store data from stores.json (single source of truth) ─────────
  const { stores: allStores } = readStores();
  const storeData = allStores.find(s => s.id === storeId);
  if (!storeData) return res.status(403).json({ error: "المتجر غير موجود" });

  storeName          = storeData.storeName;
  subscriptionStatus = storeData.subscriptionStatus;

  if (subscriptionStatus === "expired" || subscriptionStatus === "suspended") {
    return res.status(403).json({ error: "الاشتراك منتهٍ أو موقوف. تواصل مع مزود الخدمة." });
  }

  const token = crypto.randomBytes(32).toString("hex");
  sessions.set(token, { storeId, createdAt: Date.now() });
  res.json({ ok: true, token, storeId, storeName });
});

router.post("/store/logout", auth, (req, res) => {
  sessions.delete(req.headers["x-store-token"]);
  res.json({ ok: true });
});

// ─── Firebase Auth ────────────────────────────────────────────────────────────
const admin = require('./firebase-admin');

router.post("/store/firebase-login", async (req, res) => {
  const { idToken, firebaseUid: clientUid, storeId: inviteId } = req.body || {};
  if (!idToken && !clientUid) return res.status(400).json({ error: "بيانات مفقودة" });

  let uid, email;
  if (admin.apps.length && idToken) {
    try {
      const decoded = await admin.auth().verifyIdToken(idToken);
      uid   = decoded.uid;
      email = decoded.email;
    } catch (err) {
      console.error("Firebase verify:", err.message);
      return res.status(403).json({ error: "فشل التحقق من الهوية" });
    }
  } else if (clientUid) {
    uid = clientUid;
  } else {
    return res.status(400).json({ error: "لم يتم تهيئة Firebase Admin SDK على الخادم" });
  }

  try {
    const data = readStores();
    let store;

    if (inviteId) {
      const idx = data.stores.findIndex(s => s.id === inviteId && !s.firebaseUid);
      if (idx === -1) return res.status(403).json({ error: "كود الدعوة غير صحيح أو تم استخدامه مسبقاً" });
      data.stores[idx] = { ...data.stores[idx], firebaseUid: uid, ownerEmail: email || data.stores[idx].ownerEmail };
      writeStores(data);
      store = data.stores[idx];
    } else {
      store = data.stores.find(s => s.firebaseUid === uid);
      if (!store) return res.status(403).json({ error: "لا يوجد متجر مرتبط بهذا الحساب — سجّل أولاً" });
    }

    if (store.subscriptionStatus === "expired" || store.subscriptionStatus === "suspended") {
      return res.status(403).json({ error: "الاشتراك منتهٍ أو موقوف، تواصل مع مزود الخدمة" });
    }

    const token = crypto.randomBytes(32).toString("hex");
    sessions.set(token, { storeId: store.id, createdAt: Date.now() });
    res.json({ ok: true, token, storeId: store.id, storeName: store.storeName });
  } catch (err) {
    console.error("firebase-login error:", err.message);
    res.status(500).json({ error: "خطأ في الخادم" });
  }
});

// ─── Profile ──────────────────────────────────────────────────────────────────
router.get("/store/profile", auth, (req, res) => {
  const store = getStore(req.storeId);
  if (!store) return res.status(404).json({ error: "المتجر غير موجود" });
  const { token, storePassword, ...safe } = store;
  res.json({ store: safe });
});

// ─── Plan ─────────────────────────────────────────────────────────────────────
router.get("/store/plan", auth, (req, res) => {
  const store = getStore(req.storeId);
  if (!store) return res.status(404).json({ error: "المتجر غير موجود" });
  const plan = getPlan(store.plan);
  res.json({ plan: plan.id, nameAr: plan.nameAr, emoji: plan.emoji, features: plan.features });
});

// ─── Stats ────────────────────────────────────────────────────────────────────
router.get("/store/stats", auth, (req, res) => {
  const orders  = readOrders(req.storeId);
  const today   = new Date().toISOString().slice(0, 10);
  const todayOr = orders.filter(o => (o.timestamp || "").slice(0, 10) === today);

  const productCounts = {};
  for (const o of orders) {
    for (const item of (o.items || [])) {
      productCounts[item.name] = (productCounts[item.name] || 0) + item.qty;
    }
  }
  const topProducts = Object.entries(productCounts)
    .sort((a, b) => b[1] - a[1]).slice(0, 5)
    .map(([name, qty]) => ({ name, qty }));

  res.json({
    ordersTotal:  orders.length,
    ordersToday:  todayOr.length,
    revenueTotal: parseFloat(orders.reduce((s, o) => s + (o.total || 0), 0).toFixed(2)),
    revenueToday: parseFloat(todayOr.reduce((s, o) => s + (o.total || 0), 0).toFixed(2)),
    topProducts,
  });
});

// ─── Store Settings ───────────────────────────────────────────────────────────
router.put("/store/settings", auth, (req, res) => {
  const allowed = [
    "storeName", "currency", "deliveryFee",
    "workingHoursStart", "workingHoursEnd",
    "welcomeMessage", "invoiceColor", "invoiceLogoUrl",
    "requireConfirmation",
  ];
  const updates = {};
  for (const key of allowed) {
    if (req.body[key] !== undefined) updates[key] = req.body[key];
  }
  const updated = updateStore(req.storeId, updates);
  if (!updated) return res.status(404).json({ error: "المتجر غير موجود" });
  res.json({ ok: true });
});

// ─── Products ─────────────────────────────────────────────────────────────────
router.get("/store/products", auth, (req, res) => {
  const store = getStore(req.storeId);
  res.json({ products: store?.products || [], categories: store?.categories || [] });
});

router.post("/store/products", auth, (req, res) => {
  const store = getStore(req.storeId);
  if (!store) return res.status(404).json({ error: "المتجر غير موجود" });

  const product = {
    id:          "p_" + Date.now(),
    category:    req.body.category || "",
    name:        (req.body.name || "").trim(),
    description: (req.body.description || "").trim(),
    price:       parseFloat(req.body.price) || 0,
    imageUrl:    req.body.imageUrl || null,
    available:   true,
  };

  if (!product.name) return res.status(400).json({ error: "اسم المنتج مطلوب" });

  const products = [...(store.products || []), product];
  updateStore(req.storeId, { products });
  res.json({ ok: true, product });
});

router.put("/store/products/:id", auth, (req, res) => {
  const store = getStore(req.storeId);
  if (!store) return res.status(404).json({ error: "المتجر غير موجود" });

  const found = (store.products || []).find(p => p.id === req.params.id);
  if (!found) return res.status(404).json({ error: "المنتج غير موجود" });

  const products = (store.products || []).map(p =>
    p.id === req.params.id ? { ...p, ...req.body, id: p.id } : p
  );
  updateStore(req.storeId, { products });
  res.json({ ok: true });
});

router.delete("/store/products/:id", auth, (req, res) => {
  const store = getStore(req.storeId);
  if (!store) return res.status(404).json({ error: "المتجر غير موجود" });

  const products = (store.products || []).filter(p => p.id !== req.params.id);
  updateStore(req.storeId, { products });
  res.json({ ok: true });
});

// ─── Categories ───────────────────────────────────────────────────────────────
router.post("/store/categories", auth, (req, res) => {
  const store = getStore(req.storeId);
  if (!store) return res.status(404).json({ error: "المتجر غير موجود" });

  const cat = { id: "cat_" + Date.now(), name: req.body.name || "", emoji: req.body.emoji || "🍽️" };
  const categories = [...(store.categories || []), cat];
  updateStore(req.storeId, { categories });
  res.json({ ok: true, category: cat });
});

router.delete("/store/categories/:id", auth, (req, res) => {
  const store = getStore(req.storeId);
  if (!store) return res.status(404).json({ error: "المتجر غير موجود" });

  const categories = (store.categories || []).filter(c => c.id !== req.params.id);
  updateStore(req.storeId, { categories });
  res.json({ ok: true });
});

// ─── Image Upload ─────────────────────────────────────────────────────────────
router.post("/store/upload-image", auth, (req, res) => {
  const { base64, ext = "jpg" } = req.body || {};
  if (!base64) return res.status(400).json({ error: "لا توجد صورة" });

  const safeExt  = ["jpg","jpeg","png","webp"].includes(ext.toLowerCase()) ? ext.toLowerCase() : "jpg";
  const filename = `${req.storeId}_${Date.now()}.${safeExt}`;
  const imagesDir = path.join(DATA_DIR, "images");
  const filepath  = path.join(imagesDir, filename);

  try {
    fs.mkdirSync(imagesDir, { recursive: true });
    const buffer = Buffer.from(base64.replace(/^data:image\/\w+;base64,/, ""), "base64");
    if (buffer.length > 3 * 1024 * 1024) return res.status(413).json({ error: "الصورة أكبر من 3MB" });
    fs.writeFileSync(filepath, buffer);
    res.json({ ok: true, url: `/store-images/${filename}` });
  } catch (err) {
    console.error("Upload error:", err.message);
    res.status(500).json({ error: "فشل رفع الصورة" });
  }
});

function updateOrderStatus(storeId, orderId, status) {
  const file = storeId === "nakheel_001"
    ? path.join(DATA_DIR, "orders.jsonl")
    : path.join(DATA_DIR, `orders_${storeId}.jsonl`);
  if (!fs.existsSync(file)) return false;
  const lines = fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean);
  const updated = lines.map(l => {
    try {
      const obj = JSON.parse(l);
      if (obj.orderId === orderId) obj.status = status;
      return JSON.stringify(obj);
    } catch { return l; }
  });
  fs.writeFileSync(file, updated.join("\n") + "\n", "utf8");
  return true;
}

// ─── Orders ───────────────────────────────────────────────────────────────────
router.get("/store/orders", auth, (req, res) => {
  const orders = readOrders(req.storeId);
  orders.sort((a, b) => (b.timestamp || "").localeCompare(a.timestamp || ""));
  res.json({ orders: orders.slice(0, parseInt(req.query.limit) || 100) });
});

router.post("/store/orders/:orderId/confirm", auth, async (req, res) => {
  const { orderId } = req.params;
  const orders = readOrders(req.storeId);
  const order  = orders.find(o => o.orderId === orderId);
  if (!order) return res.status(404).json({ error: "الطلب غير موجود" });
  if (order.status === "confirmed") return res.status(400).json({ error: "الطلب مؤكد مسبقاً" });

  updateOrderStatus(req.storeId, orderId, "confirmed");

  const store     = getStore(req.storeId);
  const storeName = store?.storeName || "المتجر";

  // Notify customer via Baileys (same WhatsApp session used by the bot)
  if (order.customerPhone) {
    const confirmMsg =
      `✅ *تم تأكيد طلبك!*\n\n` +
      `رقم الطلب: *${orderId}*\n` +
      `سيتم توصيل طلبك قريباً إن شاء الله 🚴\n\n` +
      `شكراً لاختيارك *${storeName}*`;
    try { await waMgr.sendMessage(req.storeId, order.customerPhone, confirmMsg); } catch {}

    // Generate and send invoice image (Pro+ only)
    const { PUBLIC_URL } = process.env;
    const storeFeatures = getPlanFeatures(store?.plan);
    if (storeFeatures.invoiceImage && PUBLIC_URL) {
      try {
        const img = await generateInvoiceImage({
          orderId:          order.orderId,
          storeName:        storeName,
          invoiceColor:     store?.invoiceColor || null,
          invoiceLogoUrl:   store?.invoiceLogoUrl || null,
          customerName:     order.customerName,
          customerLocation: order.customerLocation,
          items:            order.items || [],
          subtotal:         order.subtotal,
          deliveryFee:      order.deliveryFee,
          total:            order.total,
          currency:         order.currency || "ر.س",
          date:             order.date || new Date().toISOString().slice(0, 10),
        });
        try {
          await waMgr.sendImage(req.storeId, order.customerPhone, img.filePath, `🧾 فاتورة طلبك رقم ${orderId}`);
        } catch {}
      } catch (invErr) {
        console.error("Invoice generation error:", invErr.message);
      }
    }
  }

  res.json({ ok: true });
});

router.post("/store/orders/:orderId/reject", auth, async (req, res) => {
  const { orderId } = req.params;
  const { reason }  = req.body || {};
  if (!reason) return res.status(400).json({ error: "سبب الرفض مطلوب" });

  const orders = readOrders(req.storeId);
  const order  = orders.find(o => o.orderId === orderId);
  if (!order) return res.status(404).json({ error: "الطلب غير موجود" });
  if (order.status === "rejected") return res.status(400).json({ error: "الطلب مرفوض مسبقاً" });

  updateOrderStatus(req.storeId, orderId, "rejected");

  const storeName = getStore(req.storeId)?.storeName || "المتجر";

  // Notify customer via Baileys
  if (order.customerPhone) {
    const rejectMsg =
      `❌ *نأسف، لم نتمكن من تنفيذ طلبك*\n\n` +
      `رقم الطلب: *${orderId}*\n\n` +
      `📋 السبب: ${reason}\n\n` +
      `نأسف على الإزعاج، يسعدنا خدمتك في وقت آخر 🙏\n\n` +
      `*${storeName}*`;
    try { await waMgr.sendMessage(req.storeId, order.customerPhone, rejectMsg); } catch {}
  }

  res.json({ ok: true });
});

// ─── Broadcast (Pro+) ────────────────────────────────────────────────────────
router.get("/store/broadcast/count", auth, (req, res) => {
  const { getStoreCustomerPhones } = require("./broadcast");
  const count = getStoreCustomerPhones(req.storeId).length;
  res.json({ count });
});

router.post("/store/broadcast", auth, async (req, res) => {
  const store = getStore(req.storeId);
  if (!store) return res.status(404).json({ error: "المتجر غير موجود" });

  const { getPlanFeatures } = require("./plans");
  const features = getPlanFeatures(store.plan);
  if (!features.customerRegistry) {
    return res.status(403).json({ error: "البث متاح في الباقة الاحترافية فأعلى" });
  }

  const message = (req.body?.message || "").trim();
  if (!message)        return res.status(400).json({ error: "الرسالة فارغة" });
  if (message.length > 1000) return res.status(400).json({ error: "الرسالة أكثر من 1000 حرف" });

  const { broadcast, getStoreCustomerPhones } = require("./broadcast");
  const count = getStoreCustomerPhones(req.storeId).length;

  if (count === 0) return res.status(400).json({ error: "لا يوجد عملاء للإرسال إليهم بعد" });

  // أرسل في الخلفية دون إبطاء الاستجابة
  broadcast(req.storeId, message)
    .then(r => console.log(`📢 broadcast ${req.storeId}: ${r.sent}/${r.total}`))
    .catch(e => console.error(`❌ broadcast ${req.storeId}:`, e.message));

  res.json({ ok: true, recipients: count, message: `جاري الإرسال لـ ${count} عميل 📢` });
});

// ─── Menu Image (authenticated) ──────────────────────────────────────────────
router.get("/store/menu-image", auth, async (req, res) => {
  try {
    const store = getStore(req.storeId);
    if (!store) return res.status(404).json({ error: "المتجر غير موجود" });

    const { filePath } = await generateMenuImage({
      storeId:        store.id,
      storeName:      store.storeName,
      invoiceColor:   store.invoiceColor  || null,
      invoiceLogoUrl: store.invoiceLogoUrl || null,
      categories:     store.categories    || [],
      products:       store.products      || [],
      currency:       store.currency      || "ر.س",
    });

    if (!fs.existsSync(filePath)) {
      return res.status(500).json({ error: "فشل توليد صورة المنيو" });
    }

    res.setHeader("Content-Type", "image/png");
    res.sendFile(filePath);
  } catch (err) {
    console.error("Menu image error:", err.message);
    res.status(500).json({ error: "خطأ في توليد صورة المنيو" });
  }
});

// ─── Customers (للعميل) ───────────────────────────────────────────────────────
const { getCustomers, setVip, archiveMonth } = require("./customers");

router.get("/store/customers", auth, (req, res) => {
  const all = getCustomers();
  res.json({ customers: all });
});

router.put("/store/customers/:phone/vip", auth, (req, res) => {
  const ok = setVip(req.params.phone, req.body.isVip !== false);
  if (!ok) return res.status(404).json({ error: "العميل غير موجود" });
  res.json({ ok: true });
});

router.post("/store/customers/archive", auth, (req, res) => {
  const result = archiveMonth(req.body.month);
  res.json({ ok: true, ...result });
});

// ─── WhatsApp Status (للعميل) ─────────────────────────────────────────────────
router.get("/store/wa-status", auth, (req, res) => {
  const s = waMgr.getStatus(req.storeId);
  res.json(s);
});

// ─── WhatsApp Pair (للعميل يربط رقمه بنفسه) ─────────────────────────────────
router.post("/store/wa-pair", auth, async (req, res) => {
  const { phone } = req.body || {};
  if (!phone) return res.status(400).json({ error: "رقم الهاتف مطلوب" });
  try {
    const code = await waMgr.requestPairingCode(req.storeId, phone);
    res.json({ ok: true, code });
  } catch (e) {
    console.error(`[wa-pair] ${req.storeId}:`, e.message);
    res.status(500).json({ error: "تعذّر توليد الكود — تأكد أن الرقم مسجّل في واتساب وحاول مجدداً" });
  }
});

// ─── WhatsApp Disconnect (قطع الربط وإعادة تعيين الجلسة) ─────────────────────
router.post("/store/wa-disconnect", auth, async (req, res) => {
  try {
    await waMgr.resetSession(req.storeId);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Create store token (for master impersonation) ───────────────────────────
function createStoreToken(storeId) {
  const token = crypto.randomBytes(32).toString("hex");
  sessions.set(token, { storeId, createdAt: Date.now() });
  return token;
}

module.exports = router;
module.exports.createStoreToken = createStoreToken;
