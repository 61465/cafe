/**
 * Broadcast — بث رسائل جماعية لعملاء المتجر
 * يقرأ الأرقام الفريدة من سجل الطلبات ويُرسل الرسالة لكل عميل
 * ميزة Pro فقط — مع تأخير 3 ثوانٍ بين كل رسالة لتجنب الحجب
 */

const fs    = require("fs");
const path  = require("path");
const waMgr = require("./whatsapp-manager");

const DATA_DIR = path.join(__dirname, "..", "data");

const MIN_DELAY_MS = 3_000;  // أقل تأخير بين الرسائل
const MAX_PER_RUN  = 200;    // سقف الإرسال في كل جلسة بث

/**
 * يجمع أرقام العملاء الفريدة من ملف طلبات المتجر
 */
function getStoreCustomerPhones(storeId) {
  const file = storeId === "nakheel_001"
    ? path.join(DATA_DIR, "orders.jsonl")
    : path.join(DATA_DIR, `orders_${storeId}.jsonl`);

  if (!fs.existsSync(file)) return [];

  const phones = new Set();
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    try {
      const o = JSON.parse(line);
      if (o.customerPhone) {
        const clean = String(o.customerPhone).replace(/\D/g, "");
        if (clean.length >= 9) phones.add(clean);
      }
    } catch {}
  }
  return [...phones];
}

/**
 * يُرسل رسالة جماعية لكل عملاء المتجر
 * @param {string} storeId
 * @param {string} message
 * @param {object} [opts]
 * @param {number} [opts.delayMs=3000]  - تأخير بين الرسائل
 * @returns {{ sent, failed, total }}
 */
async function broadcast(storeId, message, { delayMs = MIN_DELAY_MS } = {}) {
  const phones  = getStoreCustomerPhones(storeId).slice(0, MAX_PER_RUN);
  const results = { sent: 0, failed: 0, total: phones.length };

  if (waMgr.getStatus(storeId).status !== "open") {
    results.failed = phones.length;
    return results;
  }

  for (const phone of phones) {
    const jid = phone + "@s.whatsapp.net";
    try {
      await waMgr.sendMessage(storeId, jid, message);
      results.sent++;
    } catch {
      results.failed++;
    }
    // تأخير منع الحجب
    if (results.sent + results.failed < phones.length) {
      await new Promise(r => setTimeout(r, delayMs));
    }
  }

  console.log(`📢 [broadcast] ${storeId}: ${results.sent}/${results.total} أُرسل`);
  return results;
}

module.exports = { broadcast, getStoreCustomerPhones };
