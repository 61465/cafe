/**
 * Accounting — مدير الحسابات لكل متجر
 * ─────────────────────────────────────────────────────────────
 * Tracks:
 *   - Product costs (with versioned history)
 *   - Monthly P&L (revenue, COGS, gross/net profit)
 *   - Operating expenses (fixed + variable)
 *   - Discounts, refunds, VAT
 *   - Top profitable products ranking
 *   - Year-end closing snapshot
 *
 * Data files (per-store):
 *   data/accounting/{storeId}/product-costs.json   — current cost per product (with history)
 *   data/accounting/{storeId}/expenses.jsonl       — operating expenses
 *   data/accounting/{storeId}/monthly/{YM}.json    — monthly P&L (closed once finalized)
 *   data/accounting/{storeId}/yearly/{YYYY}.json   — year-end closing
 */

const fs   = require("fs");
const path = require("path");
const { audit } = require("./audit-log");

const DATA_DIR = path.join(__dirname, "..", "data");
const ACC_DIR  = path.join(DATA_DIR, "accounting");

function ensureStoreDir(storeId) {
  const d = path.join(ACC_DIR, storeId);
  if (!fs.existsSync(d))                fs.mkdirSync(d, { recursive: true });
  if (!fs.existsSync(path.join(d,"monthly"))) fs.mkdirSync(path.join(d,"monthly"));
  if (!fs.existsSync(path.join(d,"yearly")))  fs.mkdirSync(path.join(d,"yearly"));
  return d;
}

function readJson(file, fallback) {
  if (!fs.existsSync(file)) return fallback;
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; }
}
function writeJson(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2), "utf8");
}

// ─── Product Costs (with history) ──────────────────────────────────────────────

function _costsFile(storeId) {
  return path.join(ensureStoreDir(storeId), "product-costs.json");
}

/** يرجع جميع التكاليف الحالية: { productId: { cost, updatedAt, history: [...] } } */
function getAllProductCosts(storeId) {
  return readJson(_costsFile(storeId), {});
}

/** التكلفة الحالية لمنتج (أو 0 إذا غير موجود) */
function getProductCost(storeId, productId) {
  const all = getAllProductCosts(storeId);
  return all[productId]?.cost ?? 0;
}

/** يحدّث تكلفة منتج مع حفظ التاريخ */
function setProductCost(storeId, productId, newCost, actor, req) {
  if (newCost < 0 || !Number.isFinite(newCost)) {
    throw new Error("التكلفة يجب أن تكون رقم موجب");
  }
  const all = getAllProductCosts(storeId);
  const prev = all[productId];
  const now  = new Date().toISOString();

  const entry = {
    cost: Number(newCost),
    updatedAt: now,
    history: prev?.history || [],
  };

  if (prev && prev.cost !== Number(newCost)) {
    entry.history.unshift({
      cost: prev.cost,
      from: prev.updatedAt,
      to: now,
      changedBy: actor?.id || "store",
    });
    entry.history = entry.history.slice(0, 20); // keep last 20 changes
  }

  all[productId] = entry;
  writeJson(_costsFile(storeId), all);

  audit({
    actor: actor || { type: "store", id: storeId },
    action: "accounting.cost.change",
    target: { type: "product", id: productId },
    meta: { storeId, oldCost: prev?.cost ?? null, newCost: Number(newCost) },
  }, req);

  return entry;
}

/** التكلفة الفعلية بتاريخ معين (للحسابات التاريخية) */
function getProductCostAtDate(storeId, productId, dateISO) {
  const all = getAllProductCosts(storeId);
  const entry = all[productId];
  if (!entry) return 0;
  if (entry.updatedAt <= dateISO) return entry.cost;
  // ابحث في الـ history عن آخر تكلفة قبل التاريخ
  for (const h of (entry.history || [])) {
    if (h.from <= dateISO) return h.cost;
  }
  return entry.cost;
}

// ─── Operating Expenses ────────────────────────────────────────────────────────

function _expensesFile(storeId) {
  return path.join(ensureStoreDir(storeId), "expenses.jsonl");
}

const EXPENSE_TYPES = {
  rent:      { ar: "إيجار",          fixed: true  },
  salaries:  { ar: "رواتب",          fixed: true  },
  utilities: { ar: "كهرباء/ماء",     fixed: true  },
  internet:  { ar: "إنترنت/اتصالات", fixed: true  },
  marketing: { ar: "تسويق",          fixed: false },
  supplies:  { ar: "مستلزمات",       fixed: false },
  delivery:  { ar: "توصيل",          fixed: false },
  refund:    { ar: "مرتجعات",        fixed: false },
  other:     { ar: "أخرى",           fixed: false },
};

function addExpense(storeId, expense, actor, req) {
  const { type, amount, note, date } = expense;
  if (!EXPENSE_TYPES[type]) throw new Error("نوع المصروف غير صحيح");
  if (!Number.isFinite(amount) || amount <= 0) throw new Error("المبلغ غير صحيح");

  const entry = {
    id:        Date.now() + "-" + Math.random().toString(36).slice(2, 8),
    type,
    amount:    Number(amount),
    note:      String(note || "").slice(0, 200),
    date:      date || new Date().toISOString(),
    createdAt: new Date().toISOString(),
    fixed:     EXPENSE_TYPES[type].fixed,
  };
  fs.appendFileSync(_expensesFile(storeId), JSON.stringify(entry) + "\n");

  audit({
    actor: actor || { type: "store", id: storeId },
    action: "accounting.expense.add",
    meta: { storeId, type, amount: entry.amount },
  }, req);

  return entry;
}

function listExpenses(storeId, opts = {}) {
  const file = _expensesFile(storeId);
  if (!fs.existsSync(file)) return [];
  let list = fs.readFileSync(file, "utf8").trim().split("\n")
    .filter(Boolean)
    .map(l => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);
  if (opts.yearMonth) list = list.filter(e => (e.date || "").slice(0, 7) === opts.yearMonth);
  if (opts.year)      list = list.filter(e => (e.date || "").slice(0, 4) === opts.year);
  return list;
}

function deleteExpense(storeId, expenseId, actor, req) {
  const file = _expensesFile(storeId);
  if (!fs.existsSync(file)) return false;
  const list = listExpenses(storeId);
  const idx = list.findIndex(e => e.id === expenseId);
  if (idx < 0) return false;
  const removed = list.splice(idx, 1)[0];
  fs.writeFileSync(file, list.map(e => JSON.stringify(e)).join("\n") + (list.length ? "\n" : ""));

  audit({
    actor: actor || { type: "store", id: storeId },
    action: "accounting.expense.delete",
    meta: { storeId, expenseId, type: removed.type, amount: removed.amount },
  }, req);

  return true;
}

// ─── Order helpers ─────────────────────────────────────────────────────────────

function _ordersFile(storeId) {
  return storeId === "nakheel_001"
    ? path.join(DATA_DIR, "orders.jsonl")
    : path.join(DATA_DIR, `orders_${storeId}.jsonl`);
}

function _archiveFile(storeId, yearMonth) {
  return path.join(DATA_DIR, "archives", storeId, `${yearMonth}.jsonl`);
}

function readOrdersForMonth(storeId, yearMonth) {
  // ابحث في current + archive
  const orders = [];
  const archive = _archiveFile(storeId, yearMonth);
  if (fs.existsSync(archive)) {
    for (const l of fs.readFileSync(archive, "utf8").split("\n")) {
      if (!l) continue;
      try { orders.push(JSON.parse(l)); } catch {}
    }
  }
  const current = _ordersFile(storeId);
  if (fs.existsSync(current)) {
    for (const l of fs.readFileSync(current, "utf8").split("\n")) {
      if (!l) continue;
      try {
        const o = JSON.parse(l);
        if ((o.timestamp || o.createdAt || "").slice(0, 7) === yearMonth) orders.push(o);
      } catch {}
    }
  }
  return orders;
}

// ─── Monthly P&L Calculation ───────────────────────────────────────────────────

const VAT_RATE = 0.15; // السعودية

/**
 * يحسب P&L لشهر معين
 * @param {string} storeId
 * @param {string} yearMonth — "YYYY-MM"
 * @param {object} [opts] — { vatRate, includePending }
 * @returns كائن P&L كامل
 */
function calculateMonthlyPnL(storeId, yearMonth, opts = {}) {
  const vatRate = opts.vatRate ?? VAT_RATE;
  const includePending = !!opts.includePending;

  const orders = readOrdersForMonth(storeId, yearMonth);
  const expenses = listExpenses(storeId, { yearMonth });

  let revenue = 0;
  let cogs = 0;
  let discounts = 0;
  let ordersCount = 0;
  let completedCount = 0;
  const productAgg = new Map(); // productId → { qty, revenue, cogs, profit, name }
  const customers = new Set();

  for (const order of orders) {
    const status = order.status || "completed";
    const isCompleted = ["completed", "delivered", "done", "tasleem"].includes(status);
    if (!isCompleted && !includePending) continue;
    if (isCompleted) completedCount++;
    ordersCount++;

    if (order.customerPhone) customers.add(order.customerPhone);

    const orderTotal = Number(order.total || order.grandTotal || 0);
    const orderDiscount = Number(order.discount || order.discountAmount || 0);
    revenue += orderTotal;
    discounts += orderDiscount;

    const items = order.items || order.cart || [];
    for (const item of items) {
      const pid = item.id || item.productId || "unknown";
      const qty = Number(item.qty || item.quantity || 1);
      const price = Number(item.price || 0);
      const unitCost = getProductCostAtDate(storeId, pid, order.timestamp || order.createdAt || new Date().toISOString());
      const itemRevenue = price * qty;
      const itemCogs = unitCost * qty;
      cogs += itemCogs;

      const agg = productAgg.get(pid) || { id: pid, name: item.name || pid, qty: 0, revenue: 0, cogs: 0, profit: 0 };
      agg.qty += qty;
      agg.revenue += itemRevenue;
      agg.cogs += itemCogs;
      agg.profit = agg.revenue - agg.cogs;
      productAgg.set(pid, agg);
    }
  }

  const grossProfit = revenue - cogs;
  const grossMargin = revenue > 0 ? (grossProfit / revenue) * 100 : 0;

  const fixedExpenses    = expenses.filter(e => e.fixed).reduce((s, e) => s + e.amount, 0);
  const variableExpenses = expenses.filter(e => !e.fixed).reduce((s, e) => s + e.amount, 0);
  const totalExpenses    = fixedExpenses + variableExpenses;

  // VAT على الإيرادات (output VAT) — للسعودية، يجب على المتجر تحصيله من العميل وإرساله للهيئة
  const vatOutput = revenue * vatRate / (1 + vatRate); // assuming prices VAT-inclusive

  const netProfitBeforeVAT = grossProfit - totalExpenses;
  const netProfit = netProfitBeforeVAT; // الـ VAT pass-through، لا يطرح من الربح

  const netMargin = revenue > 0 ? (netProfit / revenue) * 100 : 0;

  // ترتيب المنتجات الأكثر ربحية
  const topProducts = [...productAgg.values()]
    .sort((a, b) => b.profit - a.profit)
    .slice(0, 10);

  const worstProducts = [...productAgg.values()]
    .filter(p => p.qty > 0)
    .sort((a, b) => (a.profit / Math.max(1, a.qty)) - (b.profit / Math.max(1, b.qty)))
    .slice(0, 5);

  return {
    storeId,
    yearMonth,
    generatedAt: new Date().toISOString(),
    revenue: round2(revenue),
    cogs: round2(cogs),
    grossProfit: round2(grossProfit),
    grossMargin: round2(grossMargin),
    fixedExpenses: round2(fixedExpenses),
    variableExpenses: round2(variableExpenses),
    totalExpenses: round2(totalExpenses),
    discounts: round2(discounts),
    vatOutput: round2(vatOutput),
    netProfit: round2(netProfit),
    netMargin: round2(netMargin),
    ordersCount,
    completedCount,
    uniqueCustomers: customers.size,
    avgOrderValue: ordersCount > 0 ? round2(revenue / ordersCount) : 0,
    topProducts,
    worstProducts,
    expensesByType: groupExpensesByType(expenses),
  };
}

function round2(n) { return Math.round(Number(n) * 100) / 100; }

function groupExpensesByType(expenses) {
  const out = {};
  for (const e of expenses) {
    if (!out[e.type]) out[e.type] = { type: e.type, ar: EXPENSE_TYPES[e.type]?.ar || e.type, total: 0, count: 0 };
    out[e.type].total = round2(out[e.type].total + e.amount);
    out[e.type].count++;
  }
  return Object.values(out).sort((a, b) => b.total - a.total);
}

// ─── Closing (Month + Year) ────────────────────────────────────────────────────

function _monthlyFile(storeId, yearMonth) {
  return path.join(ensureStoreDir(storeId), "monthly", `${yearMonth}.json`);
}

function _yearlyFile(storeId, year) {
  return path.join(ensureStoreDir(storeId), "yearly", `${year}.json`);
}

function getStoredMonthlyPnL(storeId, yearMonth) {
  return readJson(_monthlyFile(storeId, yearMonth), null);
}

function closeMonth(storeId, yearMonth, actor, req) {
  const existing = getStoredMonthlyPnL(storeId, yearMonth);
  if (existing?.closed) throw new Error("هذا الشهر مُقفل بالفعل");

  const pnl = calculateMonthlyPnL(storeId, yearMonth);
  const closed = { ...pnl, closed: true, closedAt: new Date().toISOString(), closedBy: actor?.id || "store" };
  writeJson(_monthlyFile(storeId, yearMonth), closed);

  audit({
    actor: actor || { type: "store", id: storeId },
    action: "accounting.month.close",
    target: { type: "month", id: yearMonth },
    meta: { storeId, netProfit: closed.netProfit, revenue: closed.revenue },
  }, req);

  return closed;
}

function isMonthClosed(storeId, yearMonth) {
  return !!getStoredMonthlyPnL(storeId, yearMonth)?.closed;
}

function listMonthlyReports(storeId) {
  const d = path.join(ensureStoreDir(storeId), "monthly");
  if (!fs.existsSync(d)) return [];
  return fs.readdirSync(d).filter(f => f.endsWith(".json")).map(f => f.replace(".json","")).sort().reverse();
}

function calculateYearlySummary(storeId, year) {
  const yearStr = String(year);
  const months = [];
  let revenue = 0, cogs = 0, grossProfit = 0, totalExpenses = 0, netProfit = 0, vatOutput = 0;
  let ordersCount = 0;

  for (let m = 1; m <= 12; m++) {
    const ym = `${yearStr}-${String(m).padStart(2,"0")}`;
    const stored = getStoredMonthlyPnL(storeId, ym);
    const data = stored || calculateMonthlyPnL(storeId, ym);
    months.push({ month: ym, closed: !!stored?.closed, ...data });
    revenue += data.revenue;
    cogs += data.cogs;
    grossProfit += data.grossProfit;
    totalExpenses += data.totalExpenses;
    netProfit += data.netProfit;
    vatOutput += data.vatOutput;
    ordersCount += data.ordersCount;
  }

  // Top products across the year
  const agg = new Map();
  for (const m of months) {
    for (const p of (m.topProducts || [])) {
      const cur = agg.get(p.id) || { id: p.id, name: p.name, qty: 0, revenue: 0, cogs: 0, profit: 0 };
      cur.qty += p.qty;
      cur.revenue += p.revenue;
      cur.cogs += p.cogs;
      cur.profit = cur.revenue - cur.cogs;
      agg.set(p.id, cur);
    }
  }
  const topProducts = [...agg.values()].sort((a,b)=>b.profit-a.profit).slice(0,10);

  return {
    storeId,
    year: yearStr,
    revenue: round2(revenue),
    cogs: round2(cogs),
    grossProfit: round2(grossProfit),
    grossMargin: revenue > 0 ? round2((grossProfit/revenue)*100) : 0,
    totalExpenses: round2(totalExpenses),
    netProfit: round2(netProfit),
    netMargin: revenue > 0 ? round2((netProfit/revenue)*100) : 0,
    vatOutput: round2(vatOutput),
    ordersCount,
    monthsClosedCount: months.filter(m=>m.closed).length,
    months,
    topProducts,
  };
}

function closeYear(storeId, year, actor, req) {
  const yearly = calculateYearlySummary(storeId, year);
  // كل الأشهر يجب أن تكون مُقفلة
  const open = yearly.months.filter(m => !m.closed);
  if (open.length > 0) {
    throw new Error(`لا يمكن تقفيل السنة — ${open.length} شهر مفتوح بعد. أقفل الأشهر أولاً.`);
  }
  const closed = { ...yearly, closed: true, closedAt: new Date().toISOString(), closedBy: actor?.id || "store" };
  writeJson(_yearlyFile(storeId, year), closed);

  audit({
    actor: actor || { type: "store", id: storeId },
    action: "accounting.year.close",
    target: { type: "year", id: String(year) },
    meta: { storeId, netProfit: closed.netProfit, revenue: closed.revenue },
  }, req);

  return closed;
}

// ─── Dashboard KPIs ────────────────────────────────────────────────────────────

function getDashboardKPIs(storeId) {
  const now = new Date();
  const ym = `${now.getUTCFullYear()}-${String(now.getUTCMonth()+1).padStart(2,"0")}`;
  const lastMonth = new Date(now); lastMonth.setUTCMonth(lastMonth.getUTCMonth()-1);
  const lastYm = `${lastMonth.getUTCFullYear()}-${String(lastMonth.getUTCMonth()+1).padStart(2,"0")}`;

  const current = calculateMonthlyPnL(storeId, ym);
  const previous = calculateMonthlyPnL(storeId, lastYm);

  return {
    currentMonth: ym,
    revenue: { current: current.revenue, previous: previous.revenue, change: pctChange(current.revenue, previous.revenue) },
    netProfit: { current: current.netProfit, previous: previous.netProfit, change: pctChange(current.netProfit, previous.netProfit) },
    grossMargin: { current: current.grossMargin, previous: previous.grossMargin, change: round2(current.grossMargin - previous.grossMargin) },
    orders: { current: current.ordersCount, previous: previous.ordersCount, change: pctChange(current.ordersCount, previous.ordersCount) },
    topProduct: current.topProducts[0] || null,
    worstProduct: current.worstProducts[0] || null,
    expensesByType: current.expensesByType,
  };
}

function pctChange(curr, prev) {
  if (!prev) return null;
  return round2(((curr - prev) / prev) * 100);
}

// ─── Auto monthly P&L cron (runs on 1st of month) ──────────────────────────────

function startMonthlyAccountingCron() {
  // يفحص يومياً، يحسب P&L تلقائياً لكل المتاجر إذا 1st of month
  setInterval(() => {
    const now = new Date();
    if (now.getUTCDate() !== 1) return;
    const lastMonth = new Date(now); lastMonth.setUTCDate(0);
    const ym = `${lastMonth.getUTCFullYear()}-${String(lastMonth.getUTCMonth()+1).padStart(2,"0")}`;
    if (!fs.existsSync(ACC_DIR)) return;
    const stores = fs.readdirSync(ACC_DIR);
    for (const sid of stores) {
      try {
        if (!getStoredMonthlyPnL(sid, ym)) {
          // احسب وخزّن (بدون إقفال — العميل يقفل يدوياً)
          const pnl = calculateMonthlyPnL(sid, ym);
          writeJson(_monthlyFile(sid, ym), { ...pnl, closed: false });
          console.log(`[accounting] auto-snapshot ${sid} ${ym}: net=${pnl.netProfit}`);
        }
      } catch (e) { console.warn(`[accounting] snapshot failed ${sid}:`, e.message); }
    }
  }, 6 * 60 * 60 * 1000); // كل 6 ساعات
}

module.exports = {
  EXPENSE_TYPES,
  getAllProductCosts, getProductCost, setProductCost, getProductCostAtDate,
  addExpense, listExpenses, deleteExpense,
  calculateMonthlyPnL, getStoredMonthlyPnL, closeMonth, isMonthClosed, listMonthlyReports,
  calculateYearlySummary, closeYear,
  getDashboardKPIs,
  startMonthlyAccountingCron,
};
