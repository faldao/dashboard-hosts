import { firestore, FieldValue } from '../lib/firebaseAdmin.js';

const log = (...a) => console.log('[recomputeHostingStatus]', ...a);
const sendJson = (resObj, status, payload) => {
  try {
    // Node / Next.js API Route (res is express-like)
    if (resObj && typeof resObj.setHeader === "function" && typeof resObj.status === "function" && typeof resObj.json === "function") {
      resObj.setHeader("Access-Control-Allow-Origin", "*");
      resObj.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS");
      resObj.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
      return resObj.status(status).json(payload);
    }

    // Vercel Edge / Fetch handler: devolver Response
    if (typeof Response !== "undefined") {
      const headers = { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "POST,OPTIONS" };
      return new Response(JSON.stringify(payload), { status, headers });
    }

    // Fallback: intentar escribir usando resObj (if writable)
    if (resObj && typeof resObj.writeHead === "function") {
      resObj.writeHead(status, { "Content-Type": "application/json" });
      resObj.end(JSON.stringify(payload));
      return;
    }

    // última opción: devolver payload (en ambientes test)
    return payload;
  } catch (err) {
    console.error("sendJson error", err);
    try { return resObj && resObj.status ? resObj.status(500).json({ error: "internal" }) : null; } catch {}
  }
};

const ok = (res, data) => sendJson(res, 200, data);
const bad = (res, code, error) => sendJson(res, code, { error });

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return ok(res, { ok: true });
  if (req.method !== 'POST') return bad(res, 405, 'Método no permitido');
  try {
    const { dryRun = false, batchSize = 500 } = req.body || {};
    let processed = 0, updated = 0;
    let last = null;
    while (true) {
      let q = firestore.collection('Reservas').orderBy('__name__').limit(batchSize);
      if (last) q = q.startAfter(last);
      const snap = await q.get();
      if (snap.empty) break;
      const batch = firestore.batch();
      for (const doc of snap.docs) {
        processed++;
        const d = doc.data();
        let desired = null;
        if (d.no_show_at) desired = 'no_show';
        else if (d.checkout_at) desired = 'checked_out';
        else if (d.checkin_at) desired = 'checked_in';
        else if (d.contacted_at) desired = 'contactado';
        else desired = null;

        // si hosting_status difiere, actualizarlo
        if ((d.hosting_status || null) !== desired) {
          if (!dryRun) {
            if (desired === null) batch.update(doc.ref, { hosting_status: FieldValue.delete(), lastUpdatedAt: FieldValue.serverTimestamp(), lastUpdatedBy: 'system_recompute' });
            else batch.update(doc.ref, { hosting_status: desired, lastUpdatedAt: FieldValue.serverTimestamp(), lastUpdatedBy: 'system_recompute' });
          }
          updated++;
        }
      }
      if (!dryRun) await batch.commit();
      last = snap.docs[snap.docs.length - 1];
      if (snap.size < batchSize) break;
    }
    return ok(res, { ok: true, processed, updated, dryRun });
  } catch (err) {
    log('ERROR', err?.message || err);
    return bad(res, 500, err?.message || 'Error interno');
  }
}