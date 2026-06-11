/**
 * Orders Logger
 * Appends each confirmed order to a JSONL file (one JSON per line).
 * Easy to import into Excel, Sheets, or any analytics tool later.
 */

const fs = require("fs");
const path = require("path");

const LOG_PATH = process.env.ORDERS_LOG_PATH || path.join(__dirname, "..", "data", "orders.jsonl");

function ensureDir() {
  const dir = path.dirname(LOG_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function logOrder(order) {
  try {
    ensureDir();
    const record = {
      timestamp: new Date().toISOString(),
      ...order,
    };
    fs.appendFileSync(LOG_PATH, JSON.stringify(record) + "\n", "utf8");
    return true;
  } catch (err) {
    console.error("❌ Failed to log order:", err.message);
    return false;
  }
}

function readOrders(limit = 100) {
  try {
    if (!fs.existsSync(LOG_PATH)) return [];
    const lines = fs.readFileSync(LOG_PATH, "utf8").trim().split("\n").filter(Boolean);
    return lines.slice(-limit).map((l) => {
      try { return JSON.parse(l); } catch { return null; }
    }).filter(Boolean);
  } catch (err) {
    console.error("❌ Failed to read orders:", err.message);
    return [];
  }
}

function updateOrderStatus(orderId, status) {
  try {
    if (!fs.existsSync(LOG_PATH)) return false;
    const lines = fs.readFileSync(LOG_PATH, "utf8").trim().split("\n").filter(Boolean);
    const updated = lines.map(l => {
      try {
        const obj = JSON.parse(l);
        if (obj.orderId === orderId) obj.status = status;
        return JSON.stringify(obj);
      } catch { return l; }
    });
    fs.writeFileSync(LOG_PATH, updated.join("\n") + "\n", "utf8");
    return true;
  } catch (err) {
    console.error("❌ Failed to update order:", err.message);
    return false;
  }
}

module.exports = { logOrder, readOrders, updateOrderStatus };
