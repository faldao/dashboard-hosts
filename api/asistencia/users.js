import { authAdmin, FieldValue, firestore } from '../../lib/firebaseAdmin.js';

const USERS_COLLECTION = 'attendanceUsers';
const AUDIT_COLLECTION = 'attendanceAdminEvents';

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
  const match = String(header).match(/^Bearer\s+(.+)$/i);
  return match?.[1] || null;
}

async function requireDashboardUser(req) {
  const token = bearerToken(req);
  if (!token) {
    const error = new Error('Falta autenticacion');
    error.statusCode = 401;
    throw error;
  }

  let decoded;
  try {
    decoded = await authAdmin.verifyIdToken(token);
  } catch {
    const error = new Error('Sesion invalida o vencida');
    error.statusCode = 401;
    throw error;
  }

  const profile = await firestore.collection('users').doc(decoded.uid).get();
  if (!profile.exists) {
    const error = new Error('El usuario no esta autorizado en el dashboard');
    error.statusCode = 403;
    throw error;
  }

  return decoded;
}

function cleanText(value) {
  return String(value || '').trim().replace(/\s+/g, ' ');
}

function validateUser(body, { passwordRequired = true } = {}) {
  const displayName = cleanText(body.displayName);
  const email = cleanText(body.email).toLowerCase();
  const password = String(body.password || '');

  if (displayName.length < 2 || displayName.length > 120) {
    return { error: 'Ingresa un nombre valido de hasta 120 caracteres' };
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
    return { error: 'Ingresa un email valido' };
  }
  if ((passwordRequired || password) && (password.length < 8 || password.length > 128)) {
    return { error: 'La contraseña debe tener entre 8 y 128 caracteres' };
  }

  return { displayName, email, password };
}

function serializeTimestamp(value) {
  if (!value) return null;
  if (typeof value.toDate === 'function') return value.toDate().toISOString();
  return null;
}

async function listUsers() {
  const snapshot = await firestore
    .collection(USERS_COLLECTION)
    .orderBy('displayName')
    .limit(200)
    .get();

  return snapshot.docs.map((doc) => {
    const data = doc.data() || {};
    return {
      uid: doc.id,
      displayName: data.displayName || '',
      email: data.email || '',
      active: data.active !== false,
      createdAt: serializeTimestamp(data.createdAt),
    };
  });
}

async function createUser(body, administrator) {
  const validated = validateUser(body);
  if (validated.error) {
    const error = new Error(validated.error);
    error.statusCode = 400;
    throw error;
  }

  let authUser;
  try {
    authUser = await authAdmin.createUser({
      email: validated.email,
      password: validated.password,
      displayName: validated.displayName,
      emailVerified: false,
      disabled: false,
    });
  } catch (caught) {
    if (caught?.code === 'auth/email-already-exists') {
      const error = new Error('Ya existe una cuenta con ese email');
      error.statusCode = 409;
      throw error;
    }
    throw caught;
  }

  try {
    const userRef = firestore.collection(USERS_COLLECTION).doc(authUser.uid);
    const auditRef = firestore.collection(AUDIT_COLLECTION).doc();
    const batch = firestore.batch();

    batch.set(userRef, {
      uid: authUser.uid,
      displayName: validated.displayName,
      email: validated.email,
      active: true,
      role: 'employee',
      propertyIds: [],
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
      createdBy: administrator.uid,
      createdByEmail: administrator.email || null,
    });
    batch.set(auditRef, {
      type: 'employee_created',
      employeeUid: authUser.uid,
      employeeEmail: validated.email,
      administratorUid: administrator.uid,
      administratorEmail: administrator.email || null,
      createdAt: FieldValue.serverTimestamp(),
    });

    await batch.commit();
  } catch (error) {
    await authAdmin.deleteUser(authUser.uid).catch(() => undefined);
    throw error;
  }

  return {
    uid: authUser.uid,
    displayName: validated.displayName,
    email: validated.email,
    active: true,
  };
}

async function updateUser(body, administrator) {
  const uid = cleanText(body.uid);
  if (!uid) {
    const error = new Error('Falta identificar el usuario');
    error.statusCode = 400;
    throw error;
  }

  const validated = validateUser(body, { passwordRequired: false });
  if (validated.error) {
    const error = new Error(validated.error);
    error.statusCode = 400;
    throw error;
  }

  const active = body.active !== false;
  const authUpdate = {
    displayName: validated.displayName,
    email: validated.email,
    disabled: !active,
  };
  if (validated.password) authUpdate.password = validated.password;

  try {
    await authAdmin.updateUser(uid, authUpdate);
  } catch (caught) {
    if (caught?.code === 'auth/email-already-exists') {
      const error = new Error('Ya existe una cuenta con ese email');
      error.statusCode = 409;
      throw error;
    }
    if (caught?.code === 'auth/user-not-found') {
      const error = new Error('La cuenta ya no existe');
      error.statusCode = 404;
      throw error;
    }
    throw caught;
  }

  const userRef = firestore.collection(USERS_COLLECTION).doc(uid);
  const auditRef = firestore.collection(AUDIT_COLLECTION).doc();
  const batch = firestore.batch();
  batch.set(userRef, {
    uid,
    displayName: validated.displayName,
    email: validated.email,
    active,
    updatedAt: FieldValue.serverTimestamp(),
    updatedBy: administrator.uid,
    updatedByEmail: administrator.email || null,
  }, { merge: true });
  batch.set(auditRef, {
    type: 'employee_updated',
    employeeUid: uid,
    employeeEmail: validated.email,
    passwordReset: Boolean(validated.password),
    administratorUid: administrator.uid,
    administratorEmail: administrator.email || null,
    createdAt: FieldValue.serverTimestamp(),
  });
  await batch.commit();

  return {
    uid,
    displayName: validated.displayName,
    email: validated.email,
    active,
  };
}

export default async function handler(req, res) {
  try {
    if (req.method === 'OPTIONS') return send(res, 200, { ok: true });

    const administrator = await requireDashboardUser(req);

    if (req.method === 'GET') {
      return send(res, 200, { ok: true, users: await listUsers() });
    }

    if (req.method === 'POST') {
      const user = await createUser(parseBody(req), administrator);
      return send(res, 201, { ok: true, user });
    }

    if (req.method === 'PATCH') {
      const user = await updateUser(parseBody(req), administrator);
      return send(res, 200, { ok: true, user });
    }

    return send(res, 405, { error: 'Metodo no permitido' });
  } catch (error) {
    const status = Number(error?.statusCode) || 500;
    if (status >= 500) console.error('[asistencia/users]', error);
    return send(res, status, {
      error: status >= 500 ? 'No se pudo completar la operacion' : error.message,
    });
  }
}
