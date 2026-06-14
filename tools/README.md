# 🛡️ Developer Tools

ملفات خاصة بفريق الصيانة — لا تُنشر للمتاجر.

## fetch-alerts.js

سحب تنبيهات الصيانة من VPS لجهازنا.

### الاستخدام

```bash
# آخر 24 ساعة
node tools/fetch-alerts.js

# آخر 7 أيام
node tools/fetch-alerts.js --days 7

# فقط الأخطاء الحرجة
node tools/fetch-alerts.js --level CRITICAL

# مراقبة حية كل دقيقة
node tools/fetch-alerts.js --watch

# تنزيل نسخة محلية في tools/alerts-local/
node tools/fetch-alerts.js --days 30 --download

# JSON خام للمعالجة
node tools/fetch-alerts.js --json | jq

# حالة البوت السريعة
node tools/fetch-alerts.js --status
```

### المستويات

| المستوى | الإيموجي | الاستخدام |
|---------|---------|----------|
| CRITICAL | 🚨 | crash، loss of all stores |
| ERROR | ❌ | exception، failed operation |
| WARNING | ⚠️ | high memory، slow operation |
| INFO | ℹ️ | reconnect، routine event |

### ماذا يُرصد تلقائياً

- **uncaughtException** + **unhandledRejection**
- **WhatsApp disconnect** > 5 دقائق
- **Memory** > 90% heap
- **CPU load** > 200%
- **Error rate** > 10 أخطاء/5 دقائق من نفس النوع

### المسار على VPS

```
/opt/bothatim/data/alerts/
  ├── 2026-06-14.jsonl
  ├── 2026-06-13.jsonl
  └── ...
```

كل سطر JSON منفصل (jsonl) يحوي type, level, tag, message, timestamp.

### اختياري: Webhook خارجي

لإرسال للـ Slack/Discord:

```bash
export DEV_ALERTS_WEBHOOK="https://hooks.slack.com/services/..."
```
