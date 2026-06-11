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

// Returns { starter, pro, premium } — reads from file each time (no cache — file changes at runtime)
function getPlansFromFile() {
  try {
    if (!fs.existsSync(SETTINGS_FILE)) return null;
    const raw = JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf8"));
    if (!raw.plans) return null;
    return raw.plans;
  } catch { return null; }
}

function getPlan(planId) {
  const filePlans = getPlansFromFile();
  if (filePlans?.[planId]) {
    const fp = filePlans[planId];
    return {
      id:      planId,
      nameAr:  fp.nameAr  || DEFAULT_PLANS[planId]?.nameAr,
      nameEn:  DEFAULT_PLANS[planId]?.nameEn || planId,
      emoji:   fp.emoji   || DEFAULT_PLANS[planId]?.emoji,
      color:   DEFAULT_PLANS[planId]?.color || "#6b7280",
      features: { ...DEFAULT_PLANS[planId]?.features, ...(fp.sysFeatures || fp.features || {}) },
    };
  }
  return DEFAULT_PLANS[planId] || DEFAULT_PLANS.starter;
}

function getPlanFeatures(planId) {
  return getPlan(planId).features;
}

function hasFeature(planId, feature) {
  return !!getPlanFeatures(planId)[feature];
}

// Keep PLANS for backward compat (used by master-router GET /master/plans)
const PLANS = DEFAULT_PLANS;

module.exports = { PLANS, DEFAULT_PLANS, getPlan, getPlanFeatures, hasFeature };
