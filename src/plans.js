/**
 * Subscription Plans — يقرأ من owner-settings.json ديناميكياً
 * ويعود للقيم الافتراضية إذا لم يجد الملف
 */

const fs   = require("fs");
const path = require("path");

const SETTINGS_FILE = path.join(__dirname, "..", "data", "owner-settings.json");

const DEFAULT_PLANS = {
  starter: {
    id: "starter", nameAr: "الأساسية", nameEn: "Starter", emoji: "🌱", color: "#6b7280",
    features: { adminPanel: true, invoiceImage: false, customerRegistry: false, stripe: false },
  },
  pro: {
    id: "pro", nameAr: "الاحترافية", nameEn: "Pro", emoji: "⭐", color: "#1b5e20",
    features: { adminPanel: true, invoiceImage: true, customerRegistry: true, stripe: false, webOrder: true },
  },
  premium: {
    id: "premium", nameAr: "المتقدمة", nameEn: "Premium", emoji: "👑", color: "#C9A24B",
    features: { adminPanel: true, invoiceImage: true, customerRegistry: true, stripe: true, webOrder: true },
  },
};

// Returns plans from owner-settings (dynamic — يدعم plans مخصصة من الماستر)
function getPlansFromFile() {
  try {
    if (!fs.existsSync(SETTINGS_FILE)) return null;
    const raw = JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf8"));
    if (!raw.plans || typeof raw.plans !== "object") return null;
    return raw.plans;
  } catch { return null; }
}

// Returns all plans (custom + default fallback) كقاموس
function getAllPlans() {
  const file = getPlansFromFile();
  if (file && Object.keys(file).length > 0) {
    // أكمل metadata من defaults لو موجود
    const out = {};
    for (const [id, p] of Object.entries(file)) {
      out[id] = {
        id,
        nameAr:  p.nameAr  || DEFAULT_PLANS[id]?.nameAr  || id,
        nameEn:  DEFAULT_PLANS[id]?.nameEn || p.nameEn || id,
        emoji:   p.emoji   || DEFAULT_PLANS[id]?.emoji   || "📦",
        color:   DEFAULT_PLANS[id]?.color || p.color || "#6b7280",
        price:   p.price ?? 0,
        features: { ...DEFAULT_PLANS[id]?.features, ...(p.sysFeatures || p.features || {}) },
      };
    }
    return out;
  }
  return DEFAULT_PLANS;
}

function getPlan(planId) {
  const all = getAllPlans();
  if (all[planId]) return all[planId];
  // fallback: أول باقة متاحة (لأن الماستر قد يحذف starter)
  const first = Object.values(all)[0];
  return first || DEFAULT_PLANS.starter;
}

function getPlanFeatures(planId) {
  return getPlan(planId).features;
}

function hasFeature(planId, feature) {
  return !!getPlanFeatures(planId)[feature];
}

// Keep PLANS for backward compat (used by master-router GET /master/plans)
const PLANS = DEFAULT_PLANS;

module.exports = { PLANS, DEFAULT_PLANS, getPlan, getPlanFeatures, hasFeature, getAllPlans };
