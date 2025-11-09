import { firestore, FieldValue } from '../../lib/firebaseAdmin.js';
import { DateTime } from 'luxon';

const TZ = 'America/Argentina/Buenos_Aires';
const log = (...a) => console.log('[detectUnreportedChecks]', ...a);

const ok = (res, data) => { res.setHeader('Access-Control-Allow-Origin','*'); res.setHeader('Access-Control-Allow-Methods','POST,OPTIONS'); res.setHeader('Access-Control-Allow-Headers','Content-Type'); return res.status(200).json(data); };
const bad = (res, code, error) => { res.setHeader('Access-Control-Allow-Origin','*'); res.setHeader('Access-Control-Allow-Methods','POST,OPTIONS'); res.setHeader('Access-Control-Allow-Headers','Content-Type'); return res.status(code).json({ error }); };

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return ok(res, { ok: true });
  if (req.method !== 'POST') return bad(res, 405, 'Método no permitido');
  try {
    const { dryRun = false, limit = 2000 } = req.body || {};
    const todayISO = DateTime.now().setZone(TZ).toISODate(); // YYYY-MM-DD

    const summary = { checkin_scanned:0, checkin_marked:0, checkout_scanned:0, checkout_marked:0 };

    // CHECKINS no informados (arrival_iso < today)
    const qIn = await firestore.collection('Reservas').where('arrival_iso', '<', todayISO).limit(limit).get();
    for (const d of qIn.docs) {
      summary.checkin_scanned++;
      const data = d.data();
      if (!data.checkin_at && data.hosting_status !== 'checkin_not_informed') {
        if (!dryRun) {
          await d.ref.update({ hosting_status: 'checkin_not_informed', lastUpdatedAt: FieldValue.serverTimestamp(), lastUpdatedBy: 'system_detectUnreported' });
        }
        summary.checkin_marked++;
      }
    }

    // CHECKOUTS no informados (departure_iso < today)
    const qOut = await firestore.collection('Reservas').where('departure_iso', '<', todayISO).limit(limit).get();
    for (const d of qOut.docs) {
      summary.checkout_scanned++;
      const data = d.data();
      if (!data.checkout_at && data.hosting_status !== 'checkout_not_informed') {
        if (!dryRun) {
          await d.ref.update({ hosting_status: 'checkout_not_informed', lastUpdatedAt: FieldValue.serverTimestamp(), lastUpdatedBy: 'system_detectUnreported' });
        }
        summary.checkout_marked++;
      }
    }

    return ok(res, { ok: true, dryRun, todayISO, summary });
  } catch (err) {
    log('ERROR', err?.message || err);
    return bad(res, 500, err?.message || 'Error interno');
  }
}