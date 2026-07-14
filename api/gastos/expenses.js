import { FieldValue, authAdmin, firestore } from '../../lib/firebaseAdmin.js';
import { ensureOption } from './options.js';

const EXPENSES_COLLECTION = 'Gastos';
const TZ = 'America/Argentina/Buenos_Aires';

const ok = (res, data) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  return res.status(200).json(data);
};

const bad = (res, code, error) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  return res.status(code).json({ error });
};

function parseBody(req) {
  if (!req.body) return {};
  if (typeof req.body === 'string') {
    try {
      return JSON.parse(req.body);
    } catch {
      return {};
    }
  }
  return req.body;
}

function cleanText(value) {
  return String(value || '').trim().replace(/\s+/g, ' ');
}

function toISODate(value) {
  const clean = cleanText(value);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(clean)) return null;
  return clean;
}

function normalizeCurrency(value) {
  const cur = cleanText(value).toUpperCase();
  return cur || 'ARS';
}

async function getAuthUser(req) {
  try {
    const h = req.headers?.authorization || req.headers?.Authorization || '';
    const m = h.match(/^Bearer\s+([A-Za-z0-9\-\._~\+\/]+=*)$/i);
    if (!m) return null;
    const decoded = await authAdmin.verifyIdToken(m[1]);
    const name = decoded.name || decoded.displayName || null;
    return { uid: decoded.uid, email: decoded.email || null, name };
  } catch {
    return null;
  }
}

function serializeTimestamp(value) {
  if (!value) return null;
  if (typeof value?.toDate === 'function') return value.toDate().toISOString();
  const seconds = value.seconds ?? value._seconds;
  const nanos = value.nanoseconds ?? value._nanoseconds ?? 0;
  if (Number.isFinite(Number(seconds))) {
    return new Date(Number(seconds) * 1000 + Math.floor(Number(nanos) / 1000000)).toISOString();
  }
  if (typeof value === 'string') return value;
  return null;
}

async function resolveOption(type, body, idKey, labelKey) {
  const label = cleanText(body[labelKey]);
  if (label) return ensureOption(type, label);

  const id = cleanText(body[idKey]);
  if (!id) throw new Error(`Falta ${labelKey}`);

  const snap = await firestore
    .collection('GastosAuxiliares')
    .doc(type)
    .collection('items')
    .doc(id)
    .get();

  if (!snap.exists) throw new Error(`Opcion invalida: ${type}`);
  return { id: snap.id, label: snap.data()?.label || snap.id };
}

function resolveLinkedEntity(body, idKey, nameKey) {
  const id = cleanText(body[idKey]);
  const name = cleanText(body[nameKey]);
  if (!id && !name) return null;
  return { id: id || name, nombre: name || id };
}

function serializeExpense(doc) {
  const data = doc.data() || {};
  return {
    id: doc.id,
    fecha: data.fecha || null,
    propiedad: data.propiedad || null,
    departamento: data.departamento || null,
    concepto: data.concepto || null,
    proveedor: data.proveedor || null,
    moneda: data.moneda || 'ARS',
    monto: Number(data.monto) || 0,
    tipoComprobante: data.tipoComprobante || null,
    origenFondos: data.origenFondos || null,
    observaciones: data.observaciones || '',
    createdAt: serializeTimestamp(data.createdAt),
    createdBy: data.createdBy || null,
    updatedAt: serializeTimestamp(data.updatedAt),
  };
}

async function listExpenses(req, res) {
  const from = toISODate(req.query?.from);
  const to = toISODate(req.query?.to);
  if (!from || !to) return bad(res, 400, 'Parametros from y to son obligatorios');

  const snap = await firestore
    .collection(EXPENSES_COLLECTION)
    .where('fecha', '>=', from)
    .where('fecha', '<=', to)
    .get();

  const items = snap.docs
    .map(serializeExpense)
    .sort((a, b) => String(b.fecha).localeCompare(String(a.fecha)));

  return ok(res, { ok: true, filters: { from, to, tz: TZ }, count: items.length, items });
}

async function createExpense(req, res) {
  const body = parseBody(req);
  const authUser = await getAuthUser(req);
  const fecha = toISODate(body.fecha);
  if (!fecha) throw new Error('Fecha invalida');

  const monto = Number(body.monto);
  if (!Number.isFinite(monto) || monto <= 0) throw new Error('Monto invalido');

  const propiedad = resolveLinkedEntity(body, 'propiedadId', 'propiedadNombre');
  if (!propiedad) throw new Error('Propiedad obligatoria');
  const departamento = resolveLinkedEntity(body, 'departamentoId', 'departamentoNombre');

  const [concepto, proveedor, tipoComprobante, origenFondos] = await Promise.all([
    resolveOption('conceptos', body, 'conceptoId', 'conceptoLabel'),
    resolveOption('proveedores', body, 'proveedorId', 'proveedorLabel'),
    resolveOption('tipos_comprobante', body, 'tipoComprobanteId', 'tipoComprobanteLabel'),
    resolveOption('origenes_fondos', body, 'origenFondosId', 'origenFondosLabel'),
  ]);

  const payload = {
    fecha,
    propiedad,
    departamento,
    concepto,
    proveedor,
    moneda: normalizeCurrency(body.moneda),
    monto: +monto.toFixed(2),
    tipoComprobante,
    origenFondos,
    observaciones: cleanText(body.observaciones),
    createdBy: {
      uid: authUser?.uid || null,
      email: authUser?.email || null,
      name: authUser?.name || authUser?.email || cleanText(body.createdByName) || 'Usuario',
    },
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  };

  const ref = await firestore.collection(EXPENSES_COLLECTION).add(payload);
  const saved = await ref.get();
  return ok(res, { ok: true, item: serializeExpense(saved) });
}

export default async function handler(req, res) {
  try {
    if (req.method === 'OPTIONS') return ok(res, { ok: true });
    if (req.method === 'GET') return listExpenses(req, res);
    if (req.method === 'POST') return createExpense(req, res);
    return bad(res, 405, 'Metodo no permitido');
  } catch (err) {
    console.error('[gastos/expenses]', err);
    return bad(res, 500, err?.message || 'Error interno');
  }
}
