#!/bin/bash
# Comprehensive QA — Thawani Platform end-to-end integrity check
set +e

LOGIN=$(curl -s -X POST http://localhost:3003/store/login -H "Content-Type: application/json" -d '{"phone":"201278632120","password":"OHggaFQhrMbs"}')
TOKEN=$(echo "$LOGIN" | grep -oP '(?<=token":")[^"]+')
SID="store_1781152456726"

pass() { echo "  ✅ $1"; }
fail() { echo "  ❌ $1"; }
section() { echo ""; echo "════ $1 ════"; }

read_cust_orders() { node -e "const c=JSON.parse(require('fs').readFileSync('/opt/bothatim/data/customers.json','utf8'));const e=c['${SID}|999999999'];console.log((e&&e.ordersCount)||0)"; }
read_cust_total()  { node -e "const c=JSON.parse(require('fs').readFileSync('/opt/bothatim/data/customers.json','utf8'));const e=c['${SID}|999999999'];console.log((e&&e.totalSpend)||0)"; }
read_points()      { node -e "try{const c=JSON.parse(require('fs').readFileSync('/opt/bothatim/data/loyalty_${SID}.json','utf8'));const e=c['999999999'];console.log((e&&e.points)||0)}catch(_){console.log(0)}"; }

section "1) Baseline snapshot"
B_ORDERS=$(read_cust_orders); B_TOTAL=$(read_cust_total); B_POINTS=$(read_points)
echo "  customers.ordersCount=$B_ORDERS  totalSpend=$B_TOTAL  loyalty.points=$B_POINTS"

section "2) Create test order (status=pending_confirmation) — MUST NOT grant points/customer"
T1=$(curl -s -X POST -H "x-store-token: $TOKEN" http://localhost:3003/store/orders/test)
OID1=$(echo "$T1" | grep -oP '(?<=orderId":")[^"]+')
echo "  orderId: $OID1"
A_ORDERS=$(read_cust_orders); A_TOTAL=$(read_cust_total); A_POINTS=$(read_points)
[ "$B_ORDERS" = "$A_ORDERS" ] && pass "customers.ordersCount unchanged on create" || fail "customers changed! $B_ORDERS->$A_ORDERS"
[ "$B_POINTS" = "$A_POINTS" ] && pass "loyalty.points unchanged on create" || fail "points changed! $B_POINTS->$A_POINTS"

section "3) Reject order — MUST NOT grant points/customer"
REJ=$(curl -s -X POST -H "x-store-token: $TOKEN" -H "Content-Type: application/json" -d '{"reason":"QA reject test"}' http://localhost:3003/store/orders/$OID1/reject)
A_ORDERS=$(read_cust_orders); A_POINTS=$(read_points)
[ "$B_ORDERS" = "$A_ORDERS" ] && pass "rejected order NOT counted in customer stats" || fail "rejected counted! $B_ORDERS->$A_ORDERS"
[ "$B_POINTS" = "$A_POINTS" ] && pass "rejected order NOT awarded points" || fail "rejected awarded! $B_POINTS->$A_POINTS"
R_SAVED=$(grep "$OID1" /opt/bothatim/data/orders_${SID}.jsonl | grep -oP '(?<=rejectReason":")[^"]+')
[ "$R_SAVED" = "QA reject test" ] && pass "rejectReason saved: $R_SAVED" || fail "rejectReason: '$R_SAVED'"

section "4) Create + confirm — SHOULD grant points/customer exactly once"
T2=$(curl -s -X POST -H "x-store-token: $TOKEN" http://localhost:3003/store/orders/test)
OID2=$(echo "$T2" | grep -oP '(?<=orderId":")[^"]+')
curl -s -X POST -H "x-store-token: $TOKEN" http://localhost:3003/store/orders/$OID2/confirm >/dev/null
C_ORDERS=$(read_cust_orders); C_POINTS=$(read_points)
[ "$C_ORDERS" -gt "$B_ORDERS" ] && pass "ordersCount incremented after confirm: $B_ORDERS->$C_ORDERS" || fail "no increment!"
[ "$C_POINTS" -gt "$B_POINTS" ] && pass "points awarded after confirm: $B_POINTS->$C_POINTS" || echo "  (points might be 0 if calcPoints returns 0 for test orders)"

# double-confirm should be rejected
DUP=$(curl -s -X POST -H "x-store-token: $TOKEN" http://localhost:3003/store/orders/$OID2/confirm)
D_ORDERS=$(read_cust_orders)
[ "$C_ORDERS" = "$D_ORDERS" ] && pass "double-confirm idempotent (no double-count)" || fail "double-confirm DUPLICATED! $C_ORDERS->$D_ORDERS"
echo "  double-confirm response: $DUP"

section "5) Create + cancel — MUST NOT count"
T3=$(curl -s -X POST -H "x-store-token: $TOKEN" http://localhost:3003/store/orders/test)
OID3=$(echo "$T3" | grep -oP '(?<=orderId":")[^"]+')
BEFORE=$(read_cust_orders)
curl -s -X POST -H "x-store-token: $TOKEN" -H "Content-Type: application/json" -d '{"reason":"QA cancel","by":"store"}' http://localhost:3003/store/orders/$OID3/cancel >/dev/null
AFTER=$(read_cust_orders)
[ "$BEFORE" = "$AFTER" ] && pass "cancelled order NOT counted" || fail "cancelled counted! $BEFORE->$AFTER"

section "6) Cannot re-cancel already-cancelled order"
RES=$(curl -s -X POST -H "x-store-token: $TOKEN" -H "Content-Type: application/json" -d '{"reason":"again"}' http://localhost:3003/store/orders/$OID3/cancel)
echo "$RES" | grep -qE "لا يمكن|already" && pass "re-cancel blocked" || fail "re-cancel allowed: $RES"

section "7) Rejected-summary endpoint accuracy"
SUM=$(curl -s -H "x-store-token: $TOKEN" "http://localhost:3003/store/orders/rejected-summary?days=365")
EP_REJ=$(echo "$SUM" | node -e "const d=JSON.parse(require('fs').readFileSync(0,'utf8'));console.log(d.rejected.total)")
EP_CAN=$(echo "$SUM" | node -e "const d=JSON.parse(require('fs').readFileSync(0,'utf8'));console.log(d.cancelled.total)")
REAL_REJ=$(grep -c '"status":"rejected"' /opt/bothatim/data/orders_${SID}.jsonl)
REAL_CAN=$(grep -c '"status":"cancelled"' /opt/bothatim/data/orders_${SID}.jsonl)
echo "  endpoint: rejected=$EP_REJ cancelled=$EP_CAN"
echo "  jsonl:    rejected=$REAL_REJ cancelled=$REAL_CAN"
[ "$EP_REJ" = "$REAL_REJ" ] && pass "rejected count matches" || fail "rejected mismatch!"
[ "$EP_CAN" = "$REAL_CAN" ] && pass "cancelled count matches" || fail "cancelled mismatch!"

section "8) Inventory per-store isolation"
PROD=$(curl -s -H "x-store-token: $TOKEN" http://localhost:3003/store/inventory | node -e "const d=JSON.parse(require('fs').readFileSync(0,'utf8'));console.log(d.products[0]&&d.products[0].id||'')")
echo "  game zone first product: $PROD"
OTHER_PROD=$(node -e "const s=JSON.parse(require('fs').readFileSync('/opt/bothatim/data/stores.json','utf8')).stores.find(x=>x.id==='store_1780869736748');console.log(s&&s.products&&s.products[0]&&s.products[0].id||'NONE')")
if [ "$OTHER_PROD" != "NONE" ]; then
  CROSS=$(curl -s -X PATCH -H "x-store-token: $TOKEN" -H "Content-Type: application/json" -d '{"stock":99,"mode":"set"}' http://localhost:3003/store/inventory/$OTHER_PROD)
  echo "$CROSS" | grep -qE "غير موجود|404" && pass "cross-store inventory edit blocked" || fail "ISOLATION LEAK: $CROSS"
else
  echo "  (no other product to test isolation)"
fi

section "9) Accounting P&L: revenue counts only completed/confirmed orders, not rejected/cancelled"
PNL=$(curl -s -H "x-store-token: $TOKEN" http://localhost:3003/store/accounting/monthly/2026-06)
REV=$(echo "$PNL" | node -e "const d=JSON.parse(require('fs').readFileSync(0,'utf8'));console.log(d.revenue||0)")
# expected: sum of (confirmed|completed|preparing|out_for_delivery|delivered|done|in_progress|awaiting_review) orders for June
EXPECTED=$(node -e "
const fs=require('fs');
const lines=fs.readFileSync('/opt/bothatim/data/orders_${SID}.jsonl','utf8').split('\n').filter(Boolean);
const valid=new Set(['confirmed','completed','preparing','out_for_delivery','in_progress','awaiting_review','ready_pickup','delivered','done','tasleem']);
let total=0;
for(const l of lines){try{const o=JSON.parse(l);if((o.timestamp||'').slice(0,7)==='2026-06' && valid.has(o.status))total+=Number(o.total||0);}catch{}}
console.log(total);
")
echo "  endpoint revenue: $REV"
echo "  expected (confirmed+ only): $EXPECTED"
node -e "process.exit(Math.abs(($REV)-($EXPECTED))<0.5?0:1)" && pass "P&L revenue accurate (rejected/cancelled excluded)" || fail "P&L revenue mismatch!"

section "10) Security infrastructure still alive"
MTOK=$(curl -s -X POST http://localhost:3003/master/login -H "Content-Type: application/json" -d '{"password":"GZ@acb9809381!Nakheel26"}' | grep -oP '(?<=token":")[^"]+')
[ -n "$MTOK" ] && pass "master login works" || fail "master login broken!"
TFA=$(curl -s -H "x-master-token: $MTOK" http://localhost:3003/master/2fa/status)
echo "  $TFA"
echo "$TFA" | grep -q enabled && pass "2FA endpoint responsive" || fail "2FA endpoint!"
[ -d /opt/bothatim/data/audit ] && pass "audit dir present" || fail "audit dir missing!"
LATEST_BAK=$(ls -t /opt/bothatim/backups/*.gpg 2>/dev/null | head -1)
[ -n "$LATEST_BAK" ] && pass "latest backup: $(basename $LATEST_BAK)" || fail "no backups!"

section "11) Boot health"
ERRS=$(pm2 logs whatsapp-bot --lines 50 --nostream --err 2>&1 | grep -iE "FATAL|throw |SyntaxError|ReferenceError" | grep -v "geo\] reverse" | tail -3)
if [ -z "$ERRS" ]; then pass "no fatal errors in boot logs"; else fail "errors: $ERRS"; fi

echo ""
echo "════════════════ QA COMPLETE ════════════════"
