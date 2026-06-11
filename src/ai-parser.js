/**
 * AI Intent Parser — Groq + Llama 3.3 70B
 *
 * يحلل رسائل العميل ويُرجع نية منظمة. Fast path للأرقام والكلمات الواضحة،
 * AI fallback للنصوص الطبيعية. لو فشل AI، نُرجع unknown — البوت يعود
 * للسلوك الافتراضي (buttons/lists).
 *
 * متغيرات البيئة:
 *   GROQ_API_KEY       — مفتاح Groq (مجاني من groq.com)
 *   GROQ_MODEL         — اختياري، افتراضي llama-3.3-70b-versatile
 *   AI_ENABLED         — "1" لتفعيل AI fallback، أي قيمة أخرى = معطل
 *   AI_TIMEOUT_MS      — اختياري، افتراضي 6000
 */

const GROQ_API_KEY  = process.env.GROQ_API_KEY || "";
const GROQ_MODEL    = process.env.GROQ_MODEL || "llama-3.3-70b-versatile";
const GROQ_URL      = "https://api.groq.com/openai/v1/chat/completions";
const AI_ENABLED    = process.env.AI_ENABLED === "1" && !!GROQ_API_KEY;
const AI_TIMEOUT_MS = Number(process.env.AI_TIMEOUT_MS) || 6000;

// ─── Fast-path matchers (لا تستهلك API) ──────────────────────────────────────
const KW_MENU    = /^(قائمة|قائمه|منيو|menu|قائمة\s*الطلب|اعرض\s*القائمة)$/i;
const KW_CART    = /^(سلة|سلتي|عربة|cart|اعرض\s*السلة)$/i;
const KW_CONFIRM = /^(تأكيد|أكد|اكد|تمام|تم|اوكي|اوك|confirm|ok|done)$/i;
const KW_CANCEL  = /^(إلغاء|الغاء|الغ|بطل|cancel|stop|الغي\s*الطلب)$/i;
const KW_PATH_BTN = /^(1|اختيار|ازرار|أزرار|buttons|تقليدي)$/i;
const KW_PATH_WEB = /^(2|رابط|لينك|link|webview|تفاعلية)$/i;
const KW_PATH_AI  = /^(3|كلام|كتابة|اكتب|ai|chat)$/i;

/**
 * يُرجع `{type, value}`. الأنواع المتوقعة:
 *   - "number"    → value = int
 *   - "path"      → value = "buttons" | "webview" | "ai"
 *   - "menu"      → عرض القائمة
 *   - "cart"      → عرض السلة
 *   - "confirm"   → تأكيد الطلب
 *   - "cancel"    → إلغاء
 *   - "add"       → value = [{name, qty}] — إضافة منتجات
 *   - "remove"    → value = {name} — حذف منتج
 *   - "update"    → value = {name, qty} — تعديل كمية
 *   - "question"  → value = نص السؤال (للرد العام)
 *   - "unknown"   → لم نفهم
 *
 * @param {string} text       — نص الرسالة من العميل
 * @param {object} session    — حالة الجلسة (step, cart, path, category)
 * @param {object} menuCtx    — { categories: string[], items: {[cat]: [{name, price}]} }
 */
async function parseIntent(text, session = {}, menuCtx = null) {
  const raw  = String(text || "").trim();
  const norm = raw.toLowerCase();

  // ── Fast path 1: رقم مباشر ────────────────────────────────────────────────
  if (/^\d{1,3}$/.test(raw)) {
    return { type: "number", value: parseInt(raw, 10) };
  }

  // ── Fast path 2: اختيار مسار البوت (أول رسالة) ────────────────────────────
  if (KW_PATH_BTN.test(norm)) return { type: "path", value: "buttons" };
  if (KW_PATH_WEB.test(norm)) return { type: "path", value: "webview" };
  if (KW_PATH_AI.test(norm))  return { type: "path", value: "ai" };

  // ── Fast path 3: كلمات صريحة ──────────────────────────────────────────────
  if (KW_MENU.test(norm))    return { type: "menu" };
  if (KW_CART.test(norm))    return { type: "cart" };
  if (KW_CONFIRM.test(norm)) return { type: "confirm" };
  if (KW_CANCEL.test(norm))  return { type: "cancel" };

  // ── AI fallback ────────────────────────────────────────────────────────────
  if (!AI_ENABLED) return { type: "unknown" };

  return await _aiClassify(raw, session, menuCtx);
}

async function _aiClassify(text, session, menuCtx) {
  const menuJson = menuCtx
    ? JSON.stringify(menuCtx)
    : '{"categories":[],"items":{}}';
  const cartJson = JSON.stringify(session.cart || []);
  const step     = session.step || "idle";

  const systemPrompt =
`أنت محلل نية لبوت طلبات طعام عربي. ردك يجب أن يكون JSON صرف بحقلين فقط: "type" و "value".

السياق:
- المنيو: ${menuJson}
- السلة: ${cartJson}
- الخطوة: ${step}

أمثلة على الردود المطلوبة:

رسالة: "اعرض القائمة"
رد: {"type":"menu","value":null}

رسالة: "سلتي"
رد: {"type":"cart","value":null}

رسالة: "تمام أكد الطلب"
رد: {"type":"confirm","value":null}

رسالة: "بطل الطلب"
رد: {"type":"cancel","value":null}

رسالة: "عايز كباب وعصير برتقال"
رد: {"type":"add","value":[{"name":"كباب حلة","qty":1},{"name":"عصير برتقال","qty":1}]}

رسالة: "أضف 3 شيش طاووق"
رد: {"type":"add","value":[{"name":"شيش طاووق","qty":3}]}

رسالة: "شيل العصير"
رد: {"type":"remove","value":{"name":"عصير برتقال"}}

رسالة: "خلي الكباب 2"
رد: {"type":"update","value":{"name":"كباب حلة","qty":2}}

رسالة: "كم سعر الكنافة؟"
رد: {"type":"question","value":"سعر الكنافة"}

رسالة: "السلام عليكم"
رد: {"type":"unknown","value":null}

قواعد صارمة:
- استخدم بالضبط اسم المنتج من المنيو (مثلاً "كباب حلة" وليس "كباب").
- لا تخترع منتجات غير موجودة في المنيو.
- للإضافة استخدم مصفوفة value حتى لو منتج واحد.
- لو لم تحدد كمية، qty=1.
- أعد JSON فقط، بدون شرح أو نص إضافي.`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), AI_TIMEOUT_MS);

  try {
    const res = await fetch(GROQ_URL, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${GROQ_API_KEY}`,
        "Content-Type":  "application/json",
      },
      body: JSON.stringify({
        model:           GROQ_MODEL,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user",   content: text },
        ],
        max_tokens:       250,
        temperature:      0.2,
        response_format:  { type: "json_object" },
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      console.warn(`[ai-parser] HTTP ${res.status} — fallback to unknown`);
      return { type: "unknown" };
    }

    const data    = await res.json();
    const content = data.choices?.[0]?.message?.content || "{}";
    let parsed;
    try {
      parsed = JSON.parse(content);
    } catch (e) {
      console.warn(`[ai-parser] JSON parse failed. Raw: ${content.slice(0, 200)}`);
      return { type: "unknown" };
    }

    if (typeof parsed?.type !== "string") {
      console.warn(`[ai-parser] no type field. Raw: ${content.slice(0, 200)}`);
      return { type: "unknown" };
    }
    console.log(`[ai-parser] "${text.slice(0, 40)}" → ${parsed.type}${parsed.value ? ` ${JSON.stringify(parsed.value).slice(0,80)}` : ""}`);
    return parsed;
  } catch (e) {
    console.warn(`[ai-parser] failed: ${e.message}`);
    return { type: "unknown" };
  } finally {
    clearTimeout(timer);
  }
}

// ─── AI Time Parser — يفهم أوقاتاً عامية معقدة ───────────────────────────────
// يُستخدم كـ fallback إذا فشل rule-based parser في order-scheduler.js
// Returns: { type: "absolute" | "relative", minutes?: number, hour?: number, minute?: number } or null
async function aiParseTime(text) {
  if (!AI_ENABLED) return null;
  const raw = String(text || "").trim();
  if (!raw || raw.length > 80) return null;

  const systemPrompt =
`أنت محلل أوقات لعميل عربي يطلب طعاماً. حلل النص وأرجع JSON بالشكل المحدد فقط.

أنواع النية:
1. relative: وقت نسبي من الآن (مثل "بعد نص ساعة"، "خلال ربع ساعة"). value = عدد الدقائق
2. absolute: وقت محدد في اليوم (مثل "الساعة 7 مساء"، "9 الصبح"). value = HH:MM (24h)
3. unknown: لم تفهم

أمثلة:
- "بعد نص ساعة" → {"type":"relative","minutes":30}
- "نص ساعة" → {"type":"relative","minutes":30}
- "ربع ساعة" → {"type":"relative","minutes":15}
- "بعد ١٠ دقايق" → {"type":"relative","minutes":10}
- "خلال ساعة وشوية" → {"type":"relative","minutes":75}
- "بعد كم دقيقة بس" → {"type":"relative","minutes":10}
- "بعد شوي" → {"type":"relative","minutes":15}
- "ساعة 7 المسا" → {"type":"absolute","time":"19:00"}
- "بعد العصر" → {"type":"absolute","time":"16:30"}
- "كلام غير مفهوم xxxxx" → {"type":"unknown"}

أعد JSON صرف فقط بدون أي شرح أو نص إضافي.`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), AI_TIMEOUT_MS);
  try {
    const res = await fetch(GROQ_URL, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${GROQ_API_KEY}`,
        "Content-Type":  "application/json",
      },
      body: JSON.stringify({
        model:           GROQ_MODEL,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user",   content: raw },
        ],
        max_tokens:       80,
        temperature:      0.1,
        response_format:  { type: "json_object" },
      }),
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const data    = await res.json();
    const content = data.choices?.[0]?.message?.content || "{}";
    const parsed  = JSON.parse(content);
    if (parsed?.type === "relative" && Number.isFinite(parsed.minutes) && parsed.minutes > 0 && parsed.minutes <= 1440) {
      console.log(`[ai-time] "${raw}" → +${parsed.minutes} min`);
      const d = new Date();
      d.setMinutes(d.getMinutes() + parsed.minutes);
      return d;
    }
    if (parsed?.type === "absolute" && typeof parsed.time === "string") {
      const m = parsed.time.match(/^(\d{1,2}):(\d{2})$/);
      if (m) {
        const h = parseInt(m[1], 10);
        const mn = parseInt(m[2], 10);
        if (h <= 23 && mn <= 59) {
          console.log(`[ai-time] "${raw}" → ${parsed.time}`);
          const d = new Date();
          d.setHours(h, mn, 0, 0);
          if (d <= new Date()) d.setDate(d.getDate() + 1);
          return d;
        }
      }
    }
    return null;
  } catch (e) {
    console.warn(`[ai-time] failed: ${e.message}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = {
  parseIntent,
  aiParseTime,
  AI_ENABLED,
  GROQ_MODEL,
};
