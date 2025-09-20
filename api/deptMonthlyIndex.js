// /api/deptMonthlyIndex.js
// Construye/lee el índice mensual por departamento y propiedad sin duplicar reservas.
// Fuente: DailyIndex/{yyyy-mm-dd}/props/{propId}/depts/{codigo_depto}
// Salida: DeptMonthlyIndex/{yyyy-mm}/props/{propId}/depts/{codigo_depto}

import { firestore, FieldValue } from '../lib/firebaseAdmin.js';
import { DateTime } from 'luxon';

const TZ = 'America/Argentina/Buenos_Aires';

const ok = (res, data) => res.status(200).json(data);
const bad = (res, code, error) => res.status(code).json({ error });

export default async function handler(req, res) {
  try {
    const month = (req.query.month || req.body?.month || '').trim();     // 'YYYY-MM'
    const propId = (req.query.propId || req.body?.propId || '').trim();
    const dept = (req.query.dept || req.body?.dept || '').trim();
    const rebuild = (req.query.rebuild || req.body?.rebuild || '') === '1';

    if (!month || !/^\d{4}-\d{2}$/.test(month)) {
      return bad(res, 400, "Parámetro 'month' requerido con formato YYYY-MM");
    }
    if (!propId) return bad(res, 400, "Parámetro 'propId' requerido");
    if (!dept) return bad(res, 400, "Parámetro 'dept' requerido");

    const monthRef = firestore
      .collection('DeptMonthlyIndex').doc(month)
      .collection('props').doc(propId)
      .collection('depts').doc(dept);

    const existing = await monthRef.get();
    if (existing.exists && !rebuild) {
      return ok(res, { ok: true, fromCache: true, month, propId, dept, ...existing.data() });
    }

    // Recalcular
    const start = DateTime.fromFormat(month, 'yyyy-MM', { zone: TZ }).startOf('month');
    const end = start.endOf('month');

    const idsSet = new Set();
    const counts = { checkins: 0, stays: 0, checkouts: 0, unique_reservations: 0 };
    const days = {};

    // Para nombre de propiedad y depto si querés enriquecerlo (opcional)
    let propiedad_nombre = null;
    let depto_nombre = dept;

    for (let d = start; d <= end; d = d.plus({ days: 1 })) {
      const dayISO = d.toISODate(); // YYYY-MM-DD
      days[d.toFormat('dd')] = { checkins: 0, stays: 0, checkouts: 0 };

      // Camino: DailyIndex/{day}/props/{propId}/depts/{dept}
      const ref = firestore
        .collection('DailyIndex').doc(dayISO)
        .collection('props').doc(propId)
        .collection('depts').doc(dept);

      const snap = await ref.get();
      if (!snap.exists) continue;

      const data = snap.data() || {};
      const cks = Array.isArray(data.checkins) ? data.checkins : [];
      const sts = Array.isArray(data.stays) ? data.stays : [];
      const cos = Array.isArray(data.checkouts) ? data.checkouts : [];

      cks.forEach(id => idsSet.add(id));
      sts.forEach(id => idsSet.add(id));
      cos.forEach(id => idsSet.add(id));

      counts.checkins += cks.length;
      counts.stays    += sts.length;
      counts.checkouts+= cos.length;

      days[d.toFormat('dd')].checkins  = cks.length;
      days[d.toFormat('dd')].stays     = sts.length;
      days[d.toFormat('dd')].checkouts = cos.length;

      // opcional: traigo nombres si existen en este doc (si los guardaste ahí)
      if (data?.propiedad_nombre) propiedad_nombre = data.propiedad_nombre;
      if (data?.depto_nombre) depto_nombre = data.depto_nombre;
    }

    counts.unique_reservations = idsSet.size;

    const payload = {
      month,
      tz: TZ,
      propiedad_nombre,
      depto_nombre,
      ids: Array.from(idsSet),
      counts,
      days,
      generated_at: FieldValue.serverTimestamp(),
    };

    await monthRef.set(payload, { merge: true });
    return ok(res, { ok: true, fromCache: false, month, propId, dept, ...payload });
  } catch (e) {
    console.error(e);
    return bad(res, 500, e.message || 'Error building dept monthly index');
  }
}
