import { authAdmin, FieldValue, firestore } from '../../lib/firebaseAdmin.js';

const PROPERTIES_COLLECTION = 'propiedades';
const DEPARTMENTS_COLLECTION = 'departamentos';
const AUDIT_COLLECTION = 'propertyAdminEvents';

function setHeaders(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Cache-Control', 'no-store');
}

function send(res, status, body) {
  setHeaders(res);
  return res.status(status).json(body);
}

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

function bearerToken(req) {
  const header = req.headers?.authorization || req.headers?.Authorization || '';
  return String(header).match(/^Bearer\s+(.+)$/i)?.[1] || null;
}

async function requireDashboardUser(req) {
  const token = bearerToken(req);
  if (!token) {
    const error = new Error('Falta autenticación');
    error.statusCode = 401;
    throw error;
  }

  let decoded;
  try {
    decoded = await authAdmin.verifyIdToken(token);
  } catch {
    const error = new Error('Sesión inválida o vencida');
    error.statusCode = 401;
    throw error;
  }

  const profile = await firestore.collection('users').doc(decoded.uid).get();
  if (!profile.exists) {
    const error = new Error('El usuario no está autorizado en el dashboard');
    error.statusCode = 403;
    throw error;
  }
  return decoded;
}

function cleanId(value, label) {
  const id = String(value || '').trim();
  if (!id || id.length > 150 || id.includes('/')) {
    const error = new Error(`${label} inválido`);
    error.statusCode = 400;
    throw error;
  }
  return id;
}

function cleanString(value, max = 5000) {
  if (value === null || value === undefined) return null;
  return String(value).trim().slice(0, max) || null;
}

function cleanNumber(value) {
  if (value === '' || value === null || value === undefined) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function cleanGallery(value) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => {
    if (typeof item === 'string') {
      const url = cleanString(item, 4000);
      return url ? { tag: null, url } : null;
    }
    if (!item || typeof item !== 'object') return null;
    const url = cleanString(item.url, 4000);
    if (!url) return null;
    return {
      tag: cleanString(item.tag, 250),
      url,
      ...(cleanString(item.storagePath, 1000) ? { storagePath: cleanString(item.storagePath, 1000) } : {}),
    };
  }).filter(Boolean).slice(0, 100);
}

function cleanFaq(value) {
  if (!Array.isArray(value)) return [];
  return value.filter((item) => item && typeof item === 'object').slice(0, 100);
}

function cleanObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value;
}

function normalizeProperty(data = {}) {
  const nombre = cleanString(data.nombre, 200);
  if (!nombre) {
    const error = new Error('Ingresá el nombre de la propiedad');
    error.statusCode = 400;
    throw error;
  }

  return {
    nombre,
    descripcion: cleanString(data.descripcion),
    api_key: cleanString(data.api_key, 1000),
    short_name: cleanString(data.short_name, 120),
    chatbot_rate: cleanNumber(data.chatbot_rate),
    activar_para_planillas_diarias: data.activar_para_planillas_diarias === true,
    activar_para_venta: data.activar_para_venta === true,
    estacionamiento: cleanString(data.estacionamiento, 1000),
    mascotas: cleanString(data.mascotas, 1000),
    wifi: cleanString(data.wifi, 1000),
    galeria: cleanGallery(data.galeria),
    caracteristicas: cleanObject(data.caracteristicas),
    descripcion_detallada: cleanString(data.descripcion_detallada, 15000),
    faq: cleanFaq(data.faq),
    tipo_viajero: cleanString(data.tipo_viajero, 1000),
    historia: cleanString(data.historia, 10000),
  };
}

function normalizeDepartment(data = {}) {
  const nombre = cleanString(data.nombre, 200);
  if (!nombre) {
    const error = new Error('Ingresá el nombre del departamento');
    error.statusCode = 400;
    throw error;
  }

  return {
    nombre,
    descripcion: cleanString(data.descripcion),
    wubook_shortname: cleanString(data.wubook_shortname, 120),
    consulta: cleanString(data.consulta, 5000),
    activar_para_venta: data.activar_para_venta === true,
    caracteristicas: cleanObject(data.caracteristicas),
    faq: cleanFaq(data.faq),
    galeria: cleanGallery(data.galeria),
    m2: cleanString(data.m2, 120),
    m2_num: cleanNumber(data.m2_num),
    vista: cleanString(data.vista, 500),
    dormitorios: cleanString(data.dormitorios, 500),
    capacidad: cleanString(data.capacidad, 500),
    capacidad_num: cleanNumber(data.capacidad_num),
  };
}

function serializeProperty(doc, departments = []) {
  const data = doc.data() || {};
  return {
    id: doc.id,
    nombre: data.nombre || data.name || doc.id,
    descripcion: data.descripcion || null,
    api_key: data.api_key || null,
    short_name: data.short_name || null,
    chatbot_rate: data.chatbot_rate ?? null,
    activar_para_planillas_diarias: data.activar_para_planillas_diarias === true,
    activar_para_venta: data.activar_para_venta === true,
    estacionamiento: data.estacionamiento || null,
    mascotas: data.mascotas || null,
    wifi: data.wifi || null,
    galeria: Array.isArray(data.galeria) ? data.galeria : [],
    caracteristicas: data.caracteristicas && typeof data.caracteristicas === 'object' ? data.caracteristicas : {},
    descripcion_detallada: data.descripcion_detallada || null,
    faq: Array.isArray(data.faq) ? data.faq : [],
    tipo_viajero: data.tipo_viajero || null,
    historia: data.historia || null,
    ubicacion: data.ubicacion || null,
    departments,
  };
}

function serializeDepartment(doc) {
  const data = doc.data() || {};
  return {
    id: doc.id,
    nombre: data.nombre || data.name || doc.id,
    descripcion: data.descripcion || null,
    wubook_shortname: data.wubook_shortname || null,
    consulta: data.consulta || null,
    activar_para_venta: data.activar_para_venta === true,
    caracteristicas: data.caracteristicas && typeof data.caracteristicas === 'object' ? data.caracteristicas : {},
    faq: Array.isArray(data.faq) ? data.faq : [],
    galeria: Array.isArray(data.galeria) ? data.galeria : [],
    m2: data.m2 || null,
    m2_num: data.m2_num ?? null,
    vista: data.vista || null,
    dormitorios: data.dormitorios || null,
    capacidad: data.capacidad || null,
    capacidad_num: data.capacidad_num ?? null,
  };
}

async function listProperties() {
  const snapshot = await firestore.collection(PROPERTIES_COLLECTION).limit(200).get();
  const properties = [];
  for (const propertyDoc of snapshot.docs) {
    const departmentsSnapshot = await propertyDoc.ref.collection(DEPARTMENTS_COLLECTION).limit(500).get();
    const departments = departmentsSnapshot.docs
      .map(serializeDepartment)
      .sort((a, b) => a.nombre.localeCompare(b.nombre, 'es'));
    properties.push(serializeProperty(propertyDoc, departments));
  }
  return properties.sort((a, b) => a.nombre.localeCompare(b.nombre, 'es'));
}

async function saveEntity(body, administrator, create) {
  const entity = body.entity;
  const propertyId = cleanId(body.propertyId || body.id, 'ID de propiedad');
  const propertyRef = firestore.collection(PROPERTIES_COLLECTION).doc(propertyId);
  let targetRef = propertyRef;
  let data;
  let departmentId = null;

  if (entity === 'property') {
    data = normalizeProperty(body.data);
    if (create) {
      data.ubicacion = { direccion: null, lat: null, lng: null, zona: null };
    }
  } else if (entity === 'department') {
    departmentId = cleanId(body.departmentId || body.id, 'ID de departamento');
    const propertySnapshot = await propertyRef.get();
    if (!propertySnapshot.exists) {
      const error = new Error('La propiedad seleccionada no existe');
      error.statusCode = 404;
      throw error;
    }
    targetRef = propertyRef.collection(DEPARTMENTS_COLLECTION).doc(departmentId);
    data = normalizeDepartment(body.data);
  } else {
    const error = new Error('Tipo de registro inválido');
    error.statusCode = 400;
    throw error;
  }

  const existing = await targetRef.get();
  if (create && existing.exists) {
    const error = new Error('Ya existe un registro con ese ID');
    error.statusCode = 409;
    throw error;
  }
  if (!create && !existing.exists) {
    const error = new Error('El registro ya no existe');
    error.statusCode = 404;
    throw error;
  }

  const auditRef = firestore.collection(AUDIT_COLLECTION).doc();
  const batch = firestore.batch();
  batch.set(targetRef, {
    ...data,
    ...(create ? { createdAt: FieldValue.serverTimestamp(), createdBy: administrator.uid } : {}),
    updatedAt: FieldValue.serverTimestamp(),
    updatedBy: administrator.uid,
    updatedByEmail: administrator.email || null,
  }, { merge: !create });
  batch.set(auditRef, {
    type: `${entity}_${create ? 'created' : 'updated'}`,
    propertyId,
    departmentId,
    administratorUid: administrator.uid,
    administratorEmail: administrator.email || null,
    createdAt: FieldValue.serverTimestamp(),
  });
  await batch.commit();

  return { entity, propertyId, departmentId };
}

export default async function handler(req, res) {
  try {
    if (req.method === 'OPTIONS') return send(res, 200, { ok: true });
    const administrator = await requireDashboardUser(req);

    if (req.method === 'GET') {
      return send(res, 200, { ok: true, properties: await listProperties() });
    }
    if (req.method === 'POST') {
      return send(res, 201, { ok: true, result: await saveEntity(parseBody(req), administrator, true) });
    }
    if (req.method === 'PATCH') {
      return send(res, 200, { ok: true, result: await saveEntity(parseBody(req), administrator, false) });
    }
    return send(res, 405, { error: 'Método no permitido' });
  } catch (error) {
    const status = Number(error?.statusCode) || 500;
    if (status >= 500) console.error('[admin/properties]', error);
    return send(res, status, { error: status >= 500 ? 'No se pudo completar la operación' : error.message });
  }
}
