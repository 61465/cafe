/**
 * Post-Order Rating System — تقييم ما بعد الطلب
 * يُرسل للعميل طلب تقييم بعد 5 دقائق من تأكيد الطلب
 */
const fs   = require("fs");
const path = require("path");

const RATINGS_FILE = path.join(__dirname, "..", "data", "ratings.jsonl");

const STARS = { "1": "⭐", "2": "⭐⭐", "3": "⭐⭐⭐", "4": "⭐⭐⭐⭐", "5": "⭐⭐⭐⭐⭐" };

// حفظ تقييم جديد
function saveRating({ storeId, phone, orderId, rating, comment }) {
  const entry = JSON.stringify({
    storeId, phone, orderId, rating: parseInt(rating),
    comment: comment || "", timestamp: new Date().toISOString(),
  });
  fs.appendFileSync(RATINGS_FILE, entry + "\n");
}

// قراءة تقييمات متجر
function getStoreRatings(storeId) {
  try {
    return fs.readFileSync(RATINGS_FILE, "utf8")
      .split("\n").filter(Boolean)
      .map(l => { try { return JSON.parse(l); } catch { return null; } })
      .filter(r => r && r.storeId === storeId);
  } catch { return []; }
}

// متوسط التقييم
function getAverageRating(storeId) {
  const ratings = getStoreRatings(storeId);
  if (!ratings.length) return null;
  const avg = ratings.reduce((s, r) => s + r.rating, 0) / ratings.length;
  return { average: avg.toFixed(1), count: ratings.length, stars: STARS[String(Math.round(avg))] || "⭐⭐⭐" };
}

// رسالة طلب التقييم (تُرسل بعد تأكيد الطلب)
function ratingRequestMessage(storeName, orderId) {
  return (
    `شكراً لطلبك من *${storeName}* 🌟\n\n` +
    `كيف تقيّم تجربتك معنا؟\n\n` +
    `1️⃣ — سيء\n2️⃣ — مقبول\n3️⃣ — جيد\n4️⃣ — ممتاز\n5️⃣ — رائع جداً 🔥\n\n` +
    `_أرسل الرقم للتقييم_`
  );
}

// هل هذه الرسالة تقييم؟
function isRatingInput(text) {
  return /^[1-5]$/.test((text || "").trim());
}

module.exports = { saveRating, getStoreRatings, getAverageRating, ratingRequestMessage, isRatingInput, STARS };
