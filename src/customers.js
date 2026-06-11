/**
 * Customer Registry
 * Tracks every customer who places an order.
 * VIP flag is set manually by the admin from the dashboard.
 * Monthly archive removes non-VIP customers to keep the active list clean.
 */

const fs   = require("fs");
const path = require("path");

const DATA_DIR     = path.join(__dirname, "..", "data");
const CUSTOMERS_PATH = path.join(DATA_DIR, "customers.json");
const ARCHIVE_DIR  = path.join(DATA_DIR, "archive");

function load() {
  if (!fs.existsSync(CUSTOMERS_PATH)) return {};
  try { return JSON.parse(fs.readFileSync(CUSTOMERS_PATH, "utf8")); } catch { return {}; }
}

function save(db) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(CUSTOMERS_PATH, JSON.stringify(db, null, 2), "utf8");
}

// Called after every confirmed order
function upsertCustomer({ phone, name, location, total, storeId }) {
  const db  = load();
  const now = new Date().toISOString();
  // مفتاح مركّب لمنع التسرّب بين المتاجر: storeId|phone
  const key = (storeId ? `${storeId}|` : "") + phone;
  if (!db[key]) {
    db[key] = {
      phone,
      storeId:    storeId || "",
      name:       name || "غير معروف",
      location:   location || "",
      ordersCount: 0,
      totalSpend:  0,
      firstOrder:  now,
      lastOrder:   now,
      isVip:       false,
    };
  }
  if (name) db[key].name = name;
  if (location) db[key].location = location;
  db[key].ordersCount += 1;
  db[key].totalSpend  = +(db[key].totalSpend + (total || 0)).toFixed(2);
  db[key].lastOrder   = now;
  save(db);
}

// getCustomers(storeId) — يرجع عملاء متجر محدد فقط (يمنع التسرّب)
// لو storeId غير معطى، يرجع كل العملاء (للماستر فقط)
function getCustomers(storeId) {
  const db = load();
  const all = Object.entries(db).map(([key, rec]) => ({ ...rec, _key: key }));
  // فلترة per-store (مع حماية backward-compat للسجلات القديمة بدون storeId)
  const filtered = storeId
    ? all.filter(c => c.storeId === storeId)
    : all;
  return filtered.sort((a, b) => new Date(b.lastOrder) - new Date(a.lastOrder));
}

function setVip(phone, isVip, storeId) {
  const db = load();
  const key = storeId ? `${storeId}|${phone}` : phone;
  // backward compat: لو لم يوجد بالمفتاح المركّب، جرب بدونه
  const actualKey = db[key] ? key : (db[phone] ? phone : null);
  if (!actualKey) return false;
  db[actualKey].isVip = !!isVip;
  save(db);
  return true;
}

// Archive non-VIP customers to data/archive/YYYY-MM.json and remove from active list
function archiveMonth(label) {
  const db = load();
  const tag = label || new Date().toISOString().slice(0, 7); // "2026-06"
  const toArchive = [];
  const kept      = {};

  for (const [phone, c] of Object.entries(db)) {
    if (c.isVip) { kept[phone] = c; }
    else          { toArchive.push(c); }
  }

  if (toArchive.length === 0) return { archived: 0, kept: Object.keys(kept).length };

  if (!fs.existsSync(ARCHIVE_DIR)) fs.mkdirSync(ARCHIVE_DIR, { recursive: true });
  const archivePath = path.join(ARCHIVE_DIR, `customers-${tag}.json`);

  // merge with existing archive if re-running same month
  let existing = [];
  if (fs.existsSync(archivePath)) {
    try { existing = JSON.parse(fs.readFileSync(archivePath, "utf8")); } catch {}
  }
  fs.writeFileSync(archivePath, JSON.stringify([...existing, ...toArchive], null, 2), "utf8");

  save(kept);
  return { archived: toArchive.length, kept: Object.keys(kept).length, file: archivePath };
}

module.exports = { upsertCustomer, getCustomers, setVip, archiveMonth };
