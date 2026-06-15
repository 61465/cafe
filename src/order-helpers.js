/**
 * Order helpers shared between server.js و store-router.js
 */

/**
 * يبني سطر "الموقع المسجّل" لرسالة التأكيد.
 * يضيف رابط Google Maps دائماً — إن لم تكن إحداثيات GPS، يولّد رابط بحث.
 */
// Helper مشترك: يجيب maps URL (موجود أو يولّد search query)
function _resolveMapsUrl(name, existingUrl, store) {
  if (existingUrl) return existingUrl;
  const cityCtx = store?.city ? `, ${store.city}` : "";
  const query = encodeURIComponent(`${name}${cityCtx}`).slice(0, 300);
  return `https://www.google.com/maps/search/?api=1&query=${query}`;
}

function _cleanLocationName(name) {
  // نظّف من رابط مدمج قديم بصيغة "name (📍 url)"
  return String(name || "").replace(/\s*\(📍\s*https?:\/\/[^)]+\)\s*/g, "").trim() || String(name || "");
}

/**
 * بعد تأكيد المالك — يحوي تنويه "تعديل الموقع".
 */
function buildLocationLine(order, store) {
  const rawName = order?.customerLocationName || order?.customerLocation || "";
  if (!rawName) return "";
  const cleanName = _cleanLocationName(rawName);
  const mapsUrl = _resolveMapsUrl(cleanName, order?.customerLocationMapsUrl, store);
  return (
    `\n📍 *الموقع المسجّل:* ${cleanName}\n` +
    `🗺️ ${mapsUrl}\n` +
    `_⚠️ إن لم يكن الموقع صحيحاً، اكتب: *تعديل الموقع*_\n`
  );
}

/**
 * ملخص قبل التأكيد — رابط بدون تنويه (العميل لا يزال في checkout).
 * يقبل session/order — أي object فيه customerLocationName/MapsUrl.
 */
function buildSummaryLocationLine(sessionOrOrder, store) {
  const rawName = sessionOrOrder?.customerLocationName
    || (sessionOrOrder?.customerLocation && !String(sessionOrOrder.customerLocation).startsWith("📍|") ? sessionOrOrder.customerLocation : "");
  if (!rawName) return "";
  const cleanName = _cleanLocationName(rawName);
  const mapsUrl = _resolveMapsUrl(cleanName, sessionOrOrder?.customerLocationMapsUrl, store);
  return `📍 *العنوان:* ${cleanName}\n🗺️ ${mapsUrl}\n`;
}

module.exports = { buildLocationLine, buildSummaryLocationLine };
