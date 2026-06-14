#!/usr/bin/env node
/**
 * 🛡️ Maintenance Alerts Fetcher (Developer-only)
 *
 * يجلب التنبيهات من VPS عبر SSH ويعرضها بصيغة جميلة على جهازنا.
 *
 * Usage:
 *   node tools/fetch-alerts.js              # آخر 24 ساعة
 *   node tools/fetch-alerts.js --days 7     # آخر 7 أيام
 *   node tools/fetch-alerts.js --level ERROR# مستوى محدد
 *   node tools/fetch-alerts.js --watch      # مراقبة حية كل 60 ث
 *   node tools/fetch-alerts.js --download   # احفظ نسخة محلية في tools/alerts-local/
 *
 * VPS: root@bothatim-vps (Tailscale)
 * المسار على VPS: /opt/bothatim/data/alerts/YYYY-MM-DD.jsonl
 */
const { execSync } = require("child_process");
const fs   = require("fs");
const path = require("path");

const VPS_HOST     = process.env.VPS_HOST     || "root@bothatim-vps";
const VPS_ALERTS   = "/opt/bothatim/data/alerts";
const LOCAL_DIR    = path.join(__dirname, "alerts-local");

// CLI args
const args = process.argv.slice(2);
const opts = {
  days:     +(args[args.indexOf("--days") + 1]) || 1,
  level:    args.includes("--level") ? args[args.indexOf("--level") + 1] : null,
  watch:    args.includes("--watch"),
  download: args.includes("--download"),
  status:   args.includes("--status"),
  json:     args.includes("--json"),
};

const C = {
  reset: "\x1b[0m", bold: "\x1b[1m", dim: "\x1b[2m",
  red:   "\x1b[31m", yellow: "\x1b[33m", green: "\x1b[32m",
  blue:  "\x1b[34m", magenta: "\x1b[35m", cyan: "\x1b[36m",
  gray:  "\x1b[90m",
};

const LEVEL_COLORS = {
  CRITICAL: C.red + C.bold,
  ERROR:    C.red,
  WARNING:  C.yellow,
  INFO:     C.blue,
};

function fetchDays(days) {
  const today = new Date();
  const all = [];
  for (let i = 0; i < days; i++) {
    const d = new Date(today); d.setDate(today.getDate() - i);
    const ymd = d.toISOString().slice(0, 10);
    const remoteFile = `${VPS_ALERTS}/${ymd}.jsonl`;
    try {
      const content = execSync(`ssh -o ConnectTimeout=10 ${VPS_HOST} "cat ${remoteFile} 2>/dev/null || true"`, { encoding: "utf8" });
      if (!content.trim()) continue;
      for (const line of content.split("\n")) {
        if (!line.trim()) continue;
        try { all.push(JSON.parse(line)); } catch {}
      }
      if (opts.download) {
        if (!fs.existsSync(LOCAL_DIR)) fs.mkdirSync(LOCAL_DIR, { recursive: true });
        fs.writeFileSync(path.join(LOCAL_DIR, `${ymd}.jsonl`), content);
      }
    } catch (e) {
      console.error(C.red + `❌ فشل سحب ${ymd}: ${e.message}` + C.reset);
    }
  }
  return all.sort((a, b) => (b.timestamp || "").localeCompare(a.timestamp || ""));
}

function fetchStatus() {
  try {
    const out = execSync(`ssh ${VPS_HOST} "pm2 info whatsapp-bot 2>/dev/null | grep -E 'status|uptime|restarts|memory|unstable'"`, { encoding: "utf8" });
    return out;
  } catch { return "(تعذّر الاتصال)"; }
}

function formatEntry(e) {
  const c = LEVEL_COLORS[e.level] || C.gray;
  const time = e.timestamp ? new Date(e.timestamp).toLocaleString("ar-EG", { dateStyle: "short", timeStyle: "medium" }) : "—";
  let line = "";
  if (e.type === "error") {
    line = `${C.red}❌ [${time}]${C.reset} ${C.bold}${e.tag}${C.reset}\n   ${e.message}`;
    if (e.stack && opts.json !== true) {
      const top = String(e.stack).split("\n").slice(1, 3).map(l => l.trim()).join("\n   ");
      if (top) line += `\n   ${C.gray}${top}${C.reset}`;
    }
  } else if (e.type === "alert") {
    line = `${c}${e.level === "CRITICAL" ? "🚨" : e.level === "ERROR" ? "❌" : e.level === "WARNING" ? "⚠️" : "ℹ️"} [${time}] [${e.level}]${C.reset} ${C.bold}${e.title}${C.reset}`;
    if (e.details) {
      for (const [k, v] of Object.entries(e.details).slice(0, 4)) {
        line += `\n   ${C.cyan}${k}:${C.reset} ${String(v).slice(0, 100)}`;
      }
    }
  } else {
    line = `${C.gray}ℹ️ [${time}] ${e.tag || ""}: ${JSON.stringify(e).slice(0, 100)}${C.reset}`;
  }
  return line;
}

function display(entries) {
  if (opts.json) {
    console.log(JSON.stringify(entries, null, 2));
    return;
  }
  const filtered = opts.level ? entries.filter(e => e.level === opts.level) : entries;
  if (!filtered.length) {
    console.log(`${C.green}✅ لا توجد تنبيهات في الفترة المحددة${C.reset}`);
    return;
  }

  // ملخّص
  const byLevel = filtered.reduce((acc, e) => {
    const k = e.level || (e.type === "error" ? "ERROR" : "INFO");
    acc[k] = (acc[k] || 0) + 1;
    return acc;
  }, {});
  console.log(`\n${C.bold}📊 ملخص آخر ${opts.days} يوم:${C.reset}`);
  for (const [lvl, n] of Object.entries(byLevel)) {
    const c = LEVEL_COLORS[lvl] || C.gray;
    console.log(`   ${c}${lvl}${C.reset}: ${n}`);
  }
  console.log(`   ${C.bold}إجمالي: ${filtered.length}${C.reset}\n`);

  // أنواع التنبيهات الأكثر تكراراً
  const byKey = {};
  for (const e of filtered) {
    const k = e.key || e.tag || "?";
    byKey[k] = (byKey[k] || 0) + 1;
  }
  const top = Object.entries(byKey).sort((a, b) => b[1] - a[1]).slice(0, 5);
  if (top.length) {
    console.log(`${C.bold}🔝 أكثر تكراراً:${C.reset}`);
    for (const [k, n] of top) {
      console.log(`   ${C.yellow}${n}x${C.reset} ${k}`);
    }
    console.log();
  }

  // التنبيهات
  console.log(`${C.bold}═══════════════ التنبيهات (${filtered.length}) ═══════════════${C.reset}`);
  for (const e of filtered.slice(0, 50)) {
    console.log(formatEntry(e));
    console.log();
  }
  if (filtered.length > 50) {
    console.log(`${C.dim}... و ${filtered.length - 50} تنبيه آخر (استخدم --json للحصول على الكل)${C.reset}`);
  }
}

async function main() {
  console.log(`${C.cyan}${C.bold}🛡️ Maintenance Alerts — ${VPS_HOST}${C.reset}`);
  if (opts.status) {
    console.log(`\n${C.bold}📡 حالة البوت:${C.reset}`);
    console.log(fetchStatus());
    return;
  }
  if (opts.watch) {
    console.log(`${C.dim}الوضع: مراقبة حية كل 60 ثانية... (Ctrl+C للإيقاف)${C.reset}\n`);
    const tick = async () => {
      console.clear();
      console.log(`${C.cyan}${C.bold}🛡️ Maintenance Alerts — Live${C.reset} ${C.dim}(${new Date().toLocaleString("ar-EG")})${C.reset}\n`);
      try { display(fetchDays(1)); } catch (e) { console.error("Error:", e.message); }
    };
    await tick();
    setInterval(tick, 60_000);
    return;
  }
  const entries = fetchDays(opts.days);
  display(entries);
}

main().catch(e => { console.error(C.red + "❌ " + e.message + C.reset); process.exit(1); });
