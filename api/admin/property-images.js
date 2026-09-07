import { randomUUID } from 'node:crypto';
import { authAdmin, FieldValue, firestore, storage, storageBucketName } from '../../lib/firebaseAdmin.js';

const MAX_BYTES = 3 * 1024 * 1024;

export const config = { api: { bodyParser: { sizeLimit: '5mb' } } };

function setHeaders(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, DELETE, OPTIONS');
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
    try { return JSON.parse(req.body); } catch { return {}; }
  }
  return req.body;
}

async function requireDashboardUser(req) {
  const header = req.headers?.authorization || req.headers?.Authorization || '';
  const token = String(header).match(/^Bearer\s+(.+)$/i)?.[1];
  if (!token) {
    const error = new Error('Falta autenticación');
    error.statusCode = 401;
    throw error;
  }
  let decoded;
  try { decoded = await authAdmin.verifyIdToken(token); } catch {
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

function cleanGallery(value) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => {
    if (typeof item === 'string') return { tag: null, url: item };
    if (!item || typeof item !== 'object' || !item.url) return null;
    return { tag: item.tag || null, url: item.url, ...(item.storagePath ? { storagePath: item.storagePath } : {}) };
  }).filter(Boolean);
}

async function resolveTarget(body) {
  const entity = body.entity;
  const propertyId = cleanId(body.propertyId, 'ID de propiedad');
  const propertyRef = firestore.collection('propiedades').doc(propertyId);
  let ref = propertyRef;
  let departmentId = null;
  if (entity === 'department') {
    departmentId = cleanId(body.departmentId, 'ID de departamento');
    ref = propertyRef.collection('departamentos').doc(departmentId);
  } else if (entity !== 'property') {
    const error = new Error('Tipo de galería inválido');
    error.statusCode = 400;
    throw error;
  }
  const snapshot = await ref.get();
  if (!snapshot.exists) {
    const error = new Error('Guardá el registro antes de cargar fotografías');
    error.statusCode = 404;
    throw error;
  }
  return { entity, propertyId, departmentId, ref, snapshot };
}

function extensionFor(contentType) {
  return { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' }[contentType] || null;
}

async function uploadImage(body, administrator) {
  if (!storageBucketName) throw new Error('No está configurado el bucket de fotografías');
  const target = await resolveTarget(body);
  const contentType = String(body.contentType || '').toLowerCase();
  const extension = extensionFor(contentType);
  if (!extension) {
    const error = new Error('El archivo debe ser JPG, PNG o WebP');
    error.statusCode = 400;
    throw error;
  }
  const buffer = Buffer.from(String(body.base64 || ''), 'base64');
  if (!buffer.length || buffer.length > MAX_BYTES) {
    const error = new Error('La fotografía debe pesar menos de 3 MB');
    error.statusCode = 400;
    throw error;
  }

  const token = randomUUID();
  const scope = target.entity === 'property' ? 'property' : `departments/${target.departmentId}`;
  const storagePath = `property-media/${target.propertyId}/${scope}/${Date.now()}-${randomUUID()}.${extension}`;
  const file = storage.bucket(storageBucketName).file(storagePath);
  await file.save(buffer, {
    resumable: false,
    contentType,
    metadata: {
      cacheControl: 'public,max-age=31536000,immutable',
      metadata: { firebaseStorageDownloadTokens: token },
    },
  });

  const url = `https://firebasestorage.googleapis.com/v0/b/${encodeURIComponent(storageBucketName)}/o/${encodeURIComponent(storagePath)}?alt=media&token=${token}`;
  const item = { tag: String(body.fileName || 'Fotografía').slice(0, 250), url, storagePath };
  const gallery = [...cleanGallery(target.snapshot.data()?.galeria), item];
  await target.ref.set({ galeria: gallery, updatedAt: FieldValue.serverTimestamp(), updatedBy: administrator.uid }, { merge: true });
  return { item, gallery };
}

async function deleteImage(body, administrator) {
  const target = await resolveTarget(body);
  const url = String(body.url || '');
  const storagePath = String(body.storagePath || '');
  if (!url) {
    const error = new Error('Falta identificar la fotografía');
    error.statusCode = 400;
    throw error;
  }
  const gallery = cleanGallery(target.snapshot.data()?.galeria).filter((item) => item.url !== url);
  await target.ref.set({ galeria: gallery, updatedAt: FieldValue.serverTimestamp(), updatedBy: administrator.uid }, { merge: true });
  if (storagePath.startsWith(`property-media/${target.propertyId}/`) && storageBucketName) {
    await storage.bucket(storageBucketName).file(storagePath).delete({ ignoreNotFound: true }).catch((error) => {
      console.warn('[property-images] No se pudo eliminar el objeto:', error.message);
    });
  }
  return { gallery };
}

export default async function handler(req, res) {
  try {
    if (req.method === 'OPTIONS') return send(res, 200, { ok: true });
    const administrator = await requireDashboardUser(req);
    const body = parseBody(req);
    if (req.method === 'POST') return send(res, 201, { ok: true, ...(await uploadImage(body, administrator)) });
    if (req.method === 'DELETE') return send(res, 200, { ok: true, ...(await deleteImage(body, administrator)) });
    return send(res, 405, { error: 'Método no permitido' });
  } catch (error) {
    const status = Number(error?.statusCode) || 500;
    if (status >= 500) console.error('[admin/property-images]', error);
    return send(res, status, { error: status >= 500 ? error.message || 'No se pudo completar la operación' : error.message });
  }
}
