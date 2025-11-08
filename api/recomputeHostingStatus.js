import { firestore, FieldValue } from '../lib/firebaseAdmin.js';

const log = (...a) => console.log('[recomputeHostingStatus]', ...a);
const ok = (res, data) => { res.setHeader('Access-Control-Allow-Origin','*'); res.setHeader('Access-Control-Allow-Methods','POST,OPTIONS'); res.setHeader('Access-Control-Allow-Headers','Content-Type'); return res.status(200).json(data); };
const bad = (res, code, error) => { res.setHeader('Access-Control-Allow-Origin','*'); res.setHeader('Access-Control-Allow-Methods','POST,OPTIONS'); res.setHeader('Access-Control-Allow-Headers','Content-Type'); return res.status(code).json({ error }); };

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
    return ok({ ok: true, processed, updated, dryRun });
  } catch (err) {
    log('ERROR', err?.message || err);
    return bad(res, 500, err?.message || 'Error interno');
  }
}