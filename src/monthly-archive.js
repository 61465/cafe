/**
 * Monthly Archive System — منصة ثواني
 * نهاية كل شهر:
 *   1. ينقل orders_{storeId}.jsonl → data/archives/{storeId}/{YYYY-MM}.jsonl
 *   2. يحفظ summary شهري: revenue, count, top customers, ratings
 *   3. يبدأ ملف جديد للشهر القادم
 *
 * يُستدعى تلقائياً عبر cron يومي (يفحص أول يوم من الشهر)
 */
const fs   = require("fs");
const path = require("path");

const DATA_DIR     = path.join(__dirname, "..", "data");
const ARCHIVE_DIR  = path.join(DATA_DIR, "archives");

function readStoresList() {
  try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, "stores.json"), "utf8")).stores || []; }
  catch { return []; }
}

function ensureDir(p) { if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true }); }

function readOrders(storeId) {
  const f = path.join(DATA_DIR, `orders_${storeId}.jsonl`);
  if (!fs.existsSync(f)) return [];
  return fs.readFileSync(f, "utf8").split("\n").filter(Boolean)
    .map(l => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);
}

// Archive a specific store for a specific month (YYYY-MM)
function archiveStoreMonth(storeId, yearMonth) {
  const orders = readOrders(storeId);
  // فلتر طلبات هذا الشهر
  const monthOrders = orders.filter(o => (o.date || o.timestamp || "").startsWith(yearMonth));
  if (!monthOrders.length) return { archived: 0 };

  const storeArchiveDir = path.join(ARCHIVE_DIR, storeId);
  ensureDir(storeArchiveDir);

  // اكتب الـ jsonl للأرشيف
  const archiveFile = path.join(storeArchiveDir, `${yearMonth}.jsonl`);
  fs.writeFileSync(archiveFile, monthOrders.map(o => JSON.stringify(o)).join("\n") + "\n");

  // احسب summary
  const completed = monthOrders.filter(o => o.status === "completed" || o.status === "confirmed");
  const revenue   = completed.reduce((s, o) => s + (Number(o.total) || 0), 0);
  const customers = new Set(completed.map(o => o.customerPhone).filter(Boolean));
  const topItems  = {};
  completed.forEach(o => (o.items || []).forEach(i => {
    topItems[i.name] = (topItems[i.name] || 0) + (Number(i.qty) || 1);
  }));
  const top3 = Object.entries(topItems).sort((a,b) => b[1]-a[1]).slice(0, 3)
    .map(([name, qty]) => ({ name, qty }));

  const summary = {
    storeId,
    month:        yearMonth,
    totalOrders:  monthOrders.length,
    completed:    completed.length,
    cancelled:    monthOrders.filter(o => o.status === "rejected" || o.status === "cancelled").length,
    revenue:      Math.round(revenue * 100) / 100,
    uniqueCustomers: customers.size,
    topItems:     top3,
    archivedAt:   new Date().toISOString(),
  };
  fs.writeFileSync(path.join(storeArchiveDir, `${yearMonth}.summary.json`), JSON.stringify(summary, null, 2));

  // نظّف الطلبات القديمة من الملف الحالي (احتفظ بطلبات الشهر الحالي فقط)
  const currentYearMonth = new Date().toISOString().slice(0, 7);
  const kept = orders.filter(o => (o.date || o.timestamp || "").startsWith(currentYearMonth));
  fs.writeFileSync(path.join(DATA_DIR, `orders_${storeId}.jsonl`), kept.map(o => JSON.stringify(o)).join("\n") + (kept.length ? "\n" : ""));

  console.log(`[archive] ${storeId} → ${yearMonth}: ${monthOrders.length} orders, ${revenue} revenue`);
  return { archived: monthOrders.length, summary };
}

// Archive all stores for previous month
function archivePreviousMonth() {
  const now = new Date();
  const prev = new Date(now.getFullYear(), now.getMonth() - 1, 15); // 15th to avoid timezone edge
  const yearMonth = prev.toISOString().slice(0, 7); // "2026-05"

  const stores = readStoresList();
  const results = [];
  for (const s of stores) {
    if (!s.id) continue;
    try {
      const r = archiveStoreMonth(s.id, yearMonth);
      if (r.archived > 0) results.push({ storeId: s.id, ...r });
    } catch (e) { console.error(`[archive] ${s.id} failed:`, e.message); }
  }
  return { yearMonth, results };
}

// List archived months for a store
function listArchives(storeId) {
  const dir = path.join(ARCHIVE_DIR, storeId);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(f => f.endsWith(".summary.json"))
    .map(f => {
      try { return JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")); }
      catch { return null; }
    })
    .filter(Boolean)
    .sort((a, b) => (b.month || "").localeCompare(a.month || ""));
}

// Get archived orders for a specific month
function getArchiveOrders(storeId, yearMonth) {
  const f = path.join(ARCHIVE_DIR, storeId, `${yearMonth}.jsonl`);
  if (!fs.existsSync(f)) return [];
  return fs.readFileSync(f, "utf8").split("\n").filter(Boolean)
    .map(l => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);
}

// Cron daily check — at midnight if today is day 1, archive previous month
function startMonthlyCron() {
  let lastRunMonth = null;
  const check = () => {
    const now = new Date();
    const todayMonth = now.toISOString().slice(0, 7);
    if (now.getDate() === 1 && lastRunMonth !== todayMonth) {
      console.log("[archive-cron] running monthly archive at", now.toISOString());
      try {
        archivePreviousMonth();
        lastRunMonth = todayMonth;
      } catch (e) { console.error("[archive-cron] failed:", e.message); }
    }
  };
  // فحص فوراً ثم كل ساعة
  setTimeout(check, 10_000);
  setInterval(check, 3600 * 1000);
  console.log("[archive] monthly cron started");
}

module.exports = { archiveStoreMonth, archivePreviousMonth, listArchives, getArchiveOrders, startMonthlyCron };
