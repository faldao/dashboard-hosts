// /api/reservationMutations.js
import { firestore, FieldValue } from '../lib/firebaseAdmin.js';

export default async function handler(req, res) {
  try {
    const { id, action, payload = {}, user = 'host' } = req.body || {};
    if (!id || !action) return res.status(400).json({ error: 'id y action requeridos' });

    const ref = firestore.collection('Reservas').doc(id);
    const snap = await ref.get();
    if (!snap.exists) return res.status(404).json({ error: 'Reserva no encontrada' });

    const batch = firestore.batch();

    if (action === 'checkin') {
      batch.update(ref, {
        checkin_at: payload?.when || FieldValue.serverTimestamp(),
        lastUpdatedBy: user, lastUpdatedAt: FieldValue.serverTimestamp(),
      });
      const hist = ref.collection('historial').doc();
      batch.set(hist, {
        ts: FieldValue.serverTimestamp(),
        source: 'host_ui',
        context: { action: 'checkin' },
        changeType: 'updated',
      });
    }

    if (action === 'contact') {
      batch.update(ref, {
        contacted_at: payload?.when || FieldValue.serverTimestamp(),
        contacted_by: user,
        lastUpdatedBy: user, lastUpdatedAt: FieldValue.serverTimestamp(),
      });
      const hist = ref.collection('historial').doc();
      batch.set(hist, {
        ts: FieldValue.serverTimestamp(),
        source: 'host_ui',
        context: { action: 'contact' },
        changeType: 'updated',
      });
    }

    if (action === 'addNote') {
      const noteRef = ref.collection('notas').doc();
      batch.set(noteRef, {
        ts: FieldValue.serverTimestamp(),
        by: user,
        text: payload?.text || '',
      });
    }

    if (action === 'addPayment') {
      const payRef = ref.collection('pagos').doc();
      batch.set(payRef, {
        ts: FieldValue.serverTimestamp(),
        by: user,
        method: payload?.method || 'Efectivo',
        currency: payload?.currency || 'ARS',
        amount: Number(payload?.amount || 0),
        note: payload?.note || '',
      });
      // Opcional: actualizar payment_status
      if (payload?.payment_status) {
        batch.update(ref, {
          payment_status: payload.payment_status,
          lastUpdatedBy: user, lastUpdatedAt: FieldValue.serverTimestamp(),
        });
      }
    }

    await batch.commit();
    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: e.message || 'Error mutating reservation' });
  }
}
