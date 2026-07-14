import { FieldValue, firestore } from '../../lib/firebaseAdmin.js';

const AUX_COLLECTION = 'GastosAuxiliares';

const TYPES = {
  conceptos: {
    key: 'conceptos',
    defaults: [
      'Insumos',
      'Honorarios',
      'Articulos de limpieza',
      'Lavadero',
      'Sueldos',
      'Viaticos',
      'Mantenimiento',
      'Reparaciones',
      'Servicios',
      'Comisiones',
      'Impuestos',
      'Compras operativas',
      'Equipamiento',
      'Gastos bancarios',
      'Otros',
    ],
  },
  proveedores: {
    key: 'proveedores',
    defaults: [],
  },
  tipos_comprobante: {
    key: 'tipos_comprobante',
    defaults: [
      'Factura A',
      'Factura B',
      'Factura C',
      'Recibo',
      'Ticket',
      'Comprobante interno',
      'Sin comprobante',
      'Otros',
    ],
  },
  origenes_fondos: {
    key: 'origenes_fondos',
    defaults: [
      'Caja',
      'Efectivo',
      'Banco',
      'Transferencia',
      'Mercado Pago',
      'Tarjeta de debito',
      'Tarjeta de credito',
      'Cuenta propietario',
      'Otros',
    ],
  },
};

const ALIASES = {
  concepto: 'conceptos',
  conceptos: 'conceptos',
  proveedor: 'proveedores',
  proveedores: 'proveedores',
  tipo_comprobante: 'tipos_comprobante',
  tipos_comprobante: 'tipos_comprobante',
  origen_fondos: 'origenes_fondos',
  origenes_fondos: 'origenes_fondos',
};

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

function normalizeLabel(label) {
  return String(label || '').trim().replace(/\s+/g, ' ');
}

function slugify(label) {
  const slug = normalizeLabel(label)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || `item-${Date.now()}`;
}

function resolveType(type) {
  const normalized = String(type || '').trim().toLowerCase();
  return ALIASES[normalized] || null;
}

function itemsRef(type) {
  return firestore.collection(AUX_COLLECTION).doc(type).collection('items');
}

export async function ensureOption(type, label) {
  const resolvedType = resolveType(type);
  if (!resolvedType) throw new Error('Tipo de opcion invalido');

  const cleanLabel = normalizeLabel(label);
  if (!cleanLabel) throw new Error('La opcion no puede estar vacia');

  const id = slugify(cleanLabel);
  const ref = itemsRef(resolvedType).doc(id);
  const snap = await ref.get();

  if (snap.exists) {
    const data = snap.data() || {};
    if (data.active === false || data.label !== cleanLabel) {
      await ref.set({
        label: cleanLabel,
        normalized: cleanLabel.toLowerCase(),
        active: true,
        updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true });
    }
    return { id, label: data.label || cleanLabel };
  }

  const payload = {
    label: cleanLabel,
    normalized: cleanLabel.toLowerCase(),
    active: true,
    updatedAt: FieldValue.serverTimestamp(),
    createdAt: FieldValue.serverTimestamp(),
  };

  await ref.set(payload, { merge: true });
  return { id, label: cleanLabel };
}

async function seedDefaults() {
  await Promise.all(
    Object.values(TYPES).flatMap((type) =>
      type.defaults.map((label) => ensureOption(type.key, label))
    )
  );
}

async function listType(type) {
  const snap = await itemsRef(type).where('active', '==', true).get();
  return snap.docs
    .map((doc) => ({ id: doc.id, label: doc.data()?.label || doc.id }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

async function listOptions() {
  await seedDefaults();
  const [conceptos, proveedores, tiposComprobante, origenesFondos] = await Promise.all([
    listType('conceptos'),
    listType('proveedores'),
    listType('tipos_comprobante'),
    listType('origenes_fondos'),
  ]);

  return {
    conceptos,
    proveedores,
    tiposComprobante,
    origenesFondos,
  };
}

export default async function handler(req, res) {
  try {
    if (req.method === 'OPTIONS') return ok(res, { ok: true });

    if (req.method === 'GET') {
      const type = resolveType(req.query?.type);
      if (type) {
        await seedDefaults();
        return ok(res, { ok: true, type, items: await listType(type) });
      }

      return ok(res, { ok: true, ...(await listOptions()) });
    }

    if (req.method === 'POST') {
      const body = parseBody(req);
      const item = await ensureOption(body.type, body.label);
      return ok(res, { ok: true, item });
    }

    return bad(res, 405, 'Metodo no permitido');
  } catch (err) {
    console.error('[gastos/options]', err);
    return bad(res, 500, err?.message || 'Error interno');
  }
}
