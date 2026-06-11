/**
 * Firestore Auth — إدارة حسابات أصحاب المتاجر في Firestore
 * Collection: store_admins
 * Document ID: storeId
 */

const crypto = require("crypto");
const admin  = require("./firebase-admin");

// Firestore instance (null if Firebase not configured)
let db = null;
try {
  if (admin.apps.length) {
    db = admin.firestore();
    console.log("✅ Firestore connected");
  }
} catch (e) {
  console.warn("⚠️  Firestore init failed:", e.message);
}

const COLLECTION = "store_admins";

// ─── Hash password ────────────────────────────────────────────────────────────
function hashPassword(password) {
  return crypto.createHash("sha256")
    .update("nexus_salt_2026:" + password)
    .digest("hex");
}

// ─── Upsert store admin record ────────────────────────────────────────────────
async function upsertStoreAdmin({ storeId, phone, password, storeName, subscriptionStatus, active }) {
  if (!db) return false;
  const doc = {
    storeId,
    phone:              String(phone).trim(),
    storeName:          storeName || "",
    subscriptionStatus: subscriptionStatus || "active",
    active:             active !== false,
    updatedAt:          admin.firestore.FieldValue.serverTimestamp(),
  };
  if (password) {
    doc.passwordHash = hashPassword(password);
  }
  await db.collection(COLLECTION).doc(storeId).set(doc, { merge: true });
  return true;
}

// ─── Login: phone + password → storeId ───────────────────────────────────────
async function loginStoreAdmin(phone, password) {
  if (!db) return null;

  const phoneClean = String(phone).trim();
  const snap = await db.collection(COLLECTION)
    .where("phone", "==", phoneClean)
    .limit(1)
    .get();

  if (snap.empty) return null;

  const doc  = snap.docs[0].data();
  const hash = hashPassword(password);

  if (doc.passwordHash !== hash) return null;
  if (doc.active === false)      return null;

  return {
    storeId:            doc.storeId,
    storeName:          doc.storeName,
    subscriptionStatus: doc.subscriptionStatus || "active",
  };
}

// ─── Migrate existing stores from stores.json → Firestore (one-time) ─────────
async function migrateStores(stores) {
  if (!db || !stores?.length) return;
  let count = 0;
  for (const s of stores) {
    if (!s.id || !s.ownerPhone) continue;
    try {
      const existing = await db.collection(COLLECTION).doc(s.id).get();
      // Only set if document doesn't exist (preserve manual edits)
      if (!existing.exists) {
        await upsertStoreAdmin({
          storeId:            s.id,
          phone:              s.ownerPhone,
          password:           s.storePassword || "",
          storeName:          s.storeName || "",
          subscriptionStatus: s.subscriptionStatus || "active",
          active:             s.active !== false,
        });
        count++;
      }
    } catch (e) {
      console.warn(`⚠️  Firestore migrate [${s.id}]:`, e.message);
    }
  }
  if (count) console.log(`🔄 Firestore: migrated ${count} store(s)`);
}

// ─── Delete store admin record ────────────────────────────────────────────────
async function deleteStoreAdmin(storeId) {
  if (!db) return;
  await db.collection(COLLECTION).doc(storeId).delete();
}

// ─── List all store admins (for master panel) ─────────────────────────────────
async function listStoreAdmins() {
  if (!db) return [];
  const snap = await db.collection(COLLECTION).get();
  return snap.docs.map(d => {
    const { passwordHash, ...safe } = d.data();
    return safe;
  });
}

module.exports = {
  upsertStoreAdmin,
  loginStoreAdmin,
  migrateStores,
  deleteStoreAdmin,
  listStoreAdmins,
  isReady: () => !!db,
};
