/**
 * Order helpers shared between server.js و store-router.js
 */

/**
 * يبني سطر "الموقع المسجّل" لرسالة التأكيد.
 * يضيف رابط Google Maps دائماً — إن لم تكن إحداثيات GPS، يولّد رابط بحث.
 */
function buildLocationLine(order, store) {
  const name = order?.customerLocationName || order?.customerLocation || "";
  if (!name) return "";

  let mapsUrl = order?.customerLocationMapsUrl || "";
  if (!mapsUrl) {
    // ولّد رابط بحث Google Maps من النص + مدينة المتجر للسياق
    const cityCtx = store?.city ? `, ${store.city}` : "";
    const query = encodeURIComponent(`${name}${cityCtx}`).slice(0, 300);
    mapsUrl = `https://www.google.com/maps/search/?api=1&query=${query}`;
  }
  // نظّف الـ name من أي رابط مدمج قديم بصيغة "name (📍 url)"
  const cleanName = String(name).replace(/\s*\(📍\s*https?:\/\/[^)]+\)\s*/g, "").trim() || name;
  return (
    `\n📍 *الموقع المسجّل:* ${cleanName}\n` +
    `🗺️ ${mapsUrl}\n` +
    `_⚠️ إن لم يكن الموقع صحيحاً، اكتب: *تعديل الموقع*_\n`
  );
}

module.exports = { buildLocationLine };
