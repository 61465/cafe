/**
 * Payments & Subscriptions Router
 * Stripe integration — Visa / Mastercard / Apple Pay
 * Routes: /payments/*
 */

const express = require("express");
const fs      = require("fs");
const path    = require("path");
const crypto  = require("crypto");

const router   = express.Router();
const DATA_DIR = path.join(__dirname, "..", "data");
const STORES_FILE = path.join(DATA_DIR, "stores.json");

const STRIPE_SECRET  = process.env.STRIPE_SECRET_KEY  || "";
const STRIPE_WEBHOOK = process.env.STRIPE_WEBHOOK_SECRET || "";
const PUBLIC_URL     = (process.env.PUBLIC_URL || "").replace(/\/$/, "");

// Plans config — يمكن تعديل الأسعار هنا
const PLANS = {
  basic: {
    name: "الأساسي",
    priceMonthly: 9900,   // بالهللة (99 ر.س)
    priceYearly:  89100,  // (891 ر.س = 9 شهور بسعر 10)
    currency: "sar",
    features: ["بوت واتساب كامل", "لوحة تحكم المتجر", "200 طلب/شهر", "دعم فني"],
  },
  pro: {
    name: "الاحترافي",
    priceMonthly: 19900,
    priceYearly:  179100,
    currency: "sar",
    features: ["كل مميزات الأساسي", "طلبات غير محدودة", "تقارير متقدمة", "دعم أولوي"],
  },
};

// ─── Storage helpers ──────────────────────────────────────────────────────────
function readStores() {
  try { return JSON.parse(fs.readFileSync(STORES_FILE, "utf8")); }
  catch { return { stores: [] }; }
}
function writeStores(data) {
  fs.writeFileSync(STORES_FILE, JSON.stringify(data, null, 2));
}
function updateStore(id, updates) {
  const data = readStores();
  const idx  = data.stores.findIndex(s => s.id === id);
  if (idx === -1) return null;
  data.stores[idx] = { ...data.stores[idx], ...updates, id };
  writeStores(data);
  return data.stores[idx];
}
function getStore(id) {
  return readStores().stores.find(s => s.id === id) || null;
}

// ─── Stripe lazy init (only if key is configured) ────────────────────────────
let stripe = null;
function getStripe() {
  if (!stripe && STRIPE_SECRET) stripe = require("stripe")(STRIPE_SECRET);
  return stripe;
}

// ─── GET /payments/plans — public, returns plan info ─────────────────────────
router.get("/payments/plans", (_req, res) => {
  res.json({ plans: PLANS });
});

// ─── POST /payments/create-checkout ──────────────────────────────────────────
// Body: { storeId, plan: "basic"|"pro", period: "monthly"|"yearly" }
router.post("/payments/create-checkout", async (req, res) => {
  const s = getStripe();
  if (!s) return res.status(503).json({ error: "بوابة الدفع غير مفعّلة بعد" });

  const { storeId, plan = "basic", period = "monthly" } = req.body || {};
  if (!storeId) return res.status(400).json({ error: "storeId مطلوب" });

  const store = getStore(storeId);
  if (!store) return res.status(404).json({ error: "المتجر غير موجود" });

  const planData = PLANS[plan];
  if (!planData) return res.status(400).json({ error: "خطة غير صحيحة" });

  const unitAmount = period === "yearly" ? planData.priceYearly : planData.priceMonthly;
  const label      = `${planData.name} — ${period === "yearly" ? "سنوي" : "شهري"}`;

  try {
    const session = await s.checkout.sessions.create({
      payment_method_types: ["card"],
      mode: "subscription",
      line_items: [{
        price_data: {
          currency: planData.currency,
          product_data: {
            name: `بوت واتساب — ${label}`,
            description: planData.features.join(" • "),
          },
          unit_amount: unitAmount,
          recurring: { interval: period === "yearly" ? "year" : "month" },
        },
        quantity: 1,
      }],
      metadata: { storeId, plan, period },
      customer_email: store.ownerEmail || undefined,
      success_url: `${PUBLIC_URL}/payment-success.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url:  `${PUBLIC_URL}/store-admin.html`,
      locale: "ar",
    });

    res.json({ ok: true, checkoutUrl: session.url });
  } catch (err) {
    console.error("Stripe checkout error:", err.message);
    res.status(500).json({ error: "فشل إنشاء جلسة الدفع" });
  }
});

// ─── POST /payments/manage-subscription ──────────────────────────────────────
// Body: { storeId } — returns Stripe customer portal URL
router.post("/payments/manage-subscription", async (req, res) => {
  const s = getStripe();
  if (!s) return res.status(503).json({ error: "بوابة الدفع غير مفعّلة" });

  const { storeId } = req.body || {};
  const store = getStore(storeId);
  if (!store?.stripeCustomerId) return res.status(404).json({ error: "لا يوجد اشتراك مفعّل" });

  try {
    const portal = await s.billingPortal.sessions.create({
      customer: store.stripeCustomerId,
      return_url: `${PUBLIC_URL}/store-admin.html`,
    });
    res.json({ ok: true, portalUrl: portal.url });
  } catch (err) {
    console.error("Stripe portal error:", err.message);
    res.status(500).json({ error: "فشل فتح بوابة إدارة الاشتراك" });
  }
});

// ─── POST /payments/webhook — Stripe webhook (raw body needed) ────────────────
router.post("/payments/webhook",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    if (!STRIPE_WEBHOOK) return res.sendStatus(200);

    let event;
    try {
      event = require("stripe")(STRIPE_SECRET).webhooks.constructEvent(
        req.body, req.headers["stripe-signature"], STRIPE_WEBHOOK
      );
    } catch (err) {
      console.error("Stripe webhook signature failed:", err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    const data   = event.data.object;
    const meta   = data.metadata || {};

    switch (event.type) {
      case "checkout.session.completed": {
        const storeId  = meta.storeId;
        const plan     = meta.plan || "basic";
        const period   = meta.period || "monthly";
        const months   = period === "yearly" ? 12 : 1;
        const expiry   = new Date();
        expiry.setMonth(expiry.getMonth() + months);

        updateStore(storeId, {
          subscriptionStatus:   "active",
          subscriptionPlan:     plan,
          subscriptionExpiry:   expiry.toISOString().slice(0, 10),
          stripeCustomerId:     data.customer,
          stripeSubscriptionId: data.subscription,
        });

        console.log(`✅ Payment confirmed for store ${storeId} — plan: ${plan}/${period}`);

        // إرسال إشعار واتساب للمتجر
        await sendWhatsAppPaymentConfirm(storeId, plan, period, expiry);
        break;
      }

      case "invoice.payment_succeeded": {
        // تجديد تلقائي
        const customerId = data.customer;
        const stores = readStores().stores;
        const store  = stores.find(s => s.stripeCustomerId === customerId);
        if (store) {
          const months = store.subscriptionPlan === "pro"
            ? (store.subscriptionPeriod === "yearly" ? 12 : 1)
            : 1;
          const expiry = new Date();
          expiry.setMonth(expiry.getMonth() + months);
          updateStore(store.id, {
            subscriptionStatus: "active",
            subscriptionExpiry: expiry.toISOString().slice(0, 10),
          });
          console.log(`🔄 Subscription renewed for ${store.id}`);
        }
        break;
      }

      case "customer.subscription.deleted": {
        const customerId = data.customer;
        const stores = readStores().stores;
        const store  = stores.find(s => s.stripeCustomerId === customerId);
        if (store) {
          updateStore(store.id, { subscriptionStatus: "expired" });
          console.log(`❌ Subscription cancelled for ${store.id}`);
        }
        break;
      }
    }

    res.sendStatus(200);
  }
);

// ─── GET /payments/status/:storeId — check subscription (master admin only) ──
router.get("/payments/status/:storeId", (req, res) => {
  const masterToken = req.headers["x-master-token"];
  if (masterToken !== process.env.MASTER_TOKEN) {
    return res.status(401).json({ error: "غير مصرح" });
  }
  const store = getStore(req.params.storeId);
  if (!store) return res.status(404).json({ error: "المتجر غير موجود" });
  res.json({
    storeId:             store.id,
    subscriptionStatus:  store.subscriptionStatus || "trial",
    subscriptionPlan:    store.subscriptionPlan || null,
    subscriptionExpiry:  store.subscriptionExpiry || null,
    stripeCustomerId:    store.stripeCustomerId || null,
  });
});

// ─── Helper: send WhatsApp notification after payment ────────────────────────
async function sendWhatsAppPaymentConfirm(storeId, plan, period, expiry) {
  const { WHATSAPP_TOKEN, WHATSAPP_PHONE_ID } = process.env;
  const store = getStore(storeId);
  if (!store?.ownerPhone || !WHATSAPP_TOKEN || !WHATSAPP_PHONE_ID) return;

  const planName   = PLANS[plan]?.name || plan;
  const periodText = period === "yearly" ? "سنوي" : "شهري";
  const expiryStr  = expiry.toLocaleDateString("ar-SA");

  try {
    const axios = require("axios");
    await axios.post(
      `https://graph.facebook.com/v19.0/${WHATSAPP_PHONE_ID}/messages`,
      {
        messaging_product: "whatsapp",
        to: store.ownerPhone,
        type: "text",
        text: {
          body: `✅ *تم تفعيل اشتراكك بنجاح!*\n\n🏪 المتجر: ${store.storeName}\n📦 الخطة: ${planName} (${periodText})\n📅 ينتهي في: ${expiryStr}\n\nشكراً لاختيارك خدمتنا 🙏`,
          preview_url: false,
        },
      },
      { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, "Content-Type": "application/json" } }
    );
  } catch (err) {
    console.error("WhatsApp payment confirm error:", err.message);
  }
}

module.exports = router;
