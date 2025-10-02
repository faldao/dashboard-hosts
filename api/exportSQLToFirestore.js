/**
 * ============================================================================
 *  /api/exportToFirestore.js
 *  Migración desde SQLServerBackend -> Firestore (propiedades y departamentos)
 * ============================================================================
 *
 *  RESUMEN
 *  -------
 *  Este endpoint sincroniza propiedades y sus departamentos desde tu backend
 *  `/api/SQLServerBackend` hacia Firestore. Es idempotente (upsert) y permite:
 *   - Exportar todas las propiedades y dptos filtrando por `chatbot === 1`.
 *   - Exportar una sola propiedad (por ID).
 *   - Opcionalmente, "bypassear" el filtro `chatbot` para traer TODO.
 *
 *  CARACTERÍSTICAS
 *  ---------------
 *  - Seguridad: Acepta solo POST. En producción requiere header `x-cron-secret`
 *    que debe coincidir con `process.env.CRON_SECRET`.
 *  - Robustez: reintentos con backoff exponencial, timeouts y warmup con retry.
 *  - Firestore: BulkWriter (alto throughput), `merge:true`, timestamps, manejo
 *    de errores parciales y resumen final (Multi-Status 207 si hubo errores).
 *  - Logs: redacta `api_key` en logs (***), para no filtrar secretos.
 *
 *  VARIABLES DE ENTORNO (ENV)
 *  --------------------------
 *  - FIREBASE_SERVICE_ACCOUNT_JSON  (OBLIGATORIA)
 *      JSON del service account con permisos a Firestore.
 *  - PUBLIC_BASE_URL / VERCEL_URL   (OBLIGATORIA)
 *      URL base pública del deployment. Ej: "dashboard-hosts.vercel.app"
 *      o "https://dashboard-hosts.vercel.app". Se usa PUBLIC_BASE_URL si existe,
 *      de lo contrario VERCEL_URL (prefijando https://).
 *  - CRON_SECRET                    (RECOMENDADA/OBLIGATORIA en prod)
 *      Secreto para autorizar la ejecución (header x-cron-secret).
 *
 *  SEGURIDAD
 *  ---------
 *  - En producción (NODE_ENV=production) se requiere: `x-cron-secret: <CRON_SECRET>`.
 *  - Solo método POST. Cualquier otro método devuelve 405.
 *
 *  REQUEST BODY (JSON)
 *  -------------------
 *  {
 *    "onlyPropertyId": string | number,  // Opcional: migra solo esa propiedad
 *    "bypassChatbotFilter": boolean      // Opcional: si true, NO filtra por chatbot
 *  }
 *
 *  MODOS DE USO (EJEMPLOS CURL)
 *  ----------------------------
 *  # 1) Exportación normal (filtra por chatbot === 1):
 *  curl -X POST "https://<tu-app>/api/exportToFirestore" \
 *    -H "Content-Type: application/json" \
 *    -H "x-cron-secret: $CRON_SECRET" \
 *    -d '{}'
 *
 *  # 2) Exportar TODO sin filtrar por chatbot:
 *  curl -X POST "https://<tu-app>/api/exportToFirestore" \
 *    -H "Content-Type: application/json" \
 *    -H "x-cron-secret: $CRON_SECRET" \
 *    -d '{ "bypassChatbotFilter": true }'
 *
 *  # 3) Exportar una sola propiedad (con filtro por chatbot):
 *  curl -X POST "https://<tu-app>/api/exportToFirestore" \
 *    -H "Content-Type: application/json" \
 *    -H "x-cron-secret: $CRON_SECRET" \
 *    -d '{ "onlyPropertyId": "1234" }'
 *
 *  # 4) Exportar una sola propiedad SIN filtro por chatbot:
 *  curl -X POST "https://<tu-app>/api/exportToFirestore" \
 *    -H "Content-Type: application/json" \
 *    -H "x-cron-secret: $CRON_SECRET" \
 *    -d '{ "onlyPropertyId": "1234", "bypassChatbotFilter": true }'
 *
 *  RESPUESTAS
 *  ----------
 *  200 OK
 *    { "success": true, "message": "Exportación finalizada", "summary": { ... } }
 *
 *  207 Multi-Status (errores parciales en algunas escrituras)
 *    { "success": false, "message": "Exportación finalizada", "summary": { errors:[...] } }
 *
 *  401 Unauthorized (en prod sin x-cron-secret válido)
 *    { "success": false, "error": "No autorizado." }
 *
 *  404 Not Found (onlyPropertyId no existe en origen)
 *    { "success": false, "error": "No se encontró la propiedad <id>." }
 *
 *  405 Method Not Allowed (no-POST)
 *    { "success": false, "error": "Método no permitido. Usá POST." }
 *
 *  500/502 (fallos de red/origen o formato inesperado)
 *    { "success": false, "error": "..." }
 *
 *  ESQUEMA EN FIRESTORE (UPSERT con merge:true)
 *  --------------------------------------------
 *  propiedades/{property_id}:
 *    - nombre: string
 *    - descripcion: string
 *    - api_key: string
 *    - short_name: string
 *    - chatbot_rate: number | null
 *    - activar_para_planillas_diarias: boolean
 *    - activar_para_venta: boolean
 *    - estacionamiento: string
 *    - mascotas: string
 *    - wifi: string
 *    - galeria: {tag,url}[] (no se pisa con [])
 *    - caracteristicas: object (no se pisa con {})
 *    - descripcion_detallada: string
 *    - faq: any[]
 *    - tipo_viajero: string
 *    - historia: string
 *    - ubicacion: { direccion?: string, lat?: string, lng?: string, zona?: string }
 *    - source: "exportToFirestore"
 *    - createdAt: serverTimestamp
 *    - updatedAt: serverTimestamp
 *
 *  propiedades/{property_id}/departamentos/{apartment_id}:
 *    - nombre, descripcion, wubook_shortname, consulta
 *    - activar_para_venta: boolean
 *    - caracteristicas: object
 *    - faq: any[]
 *    - galeria: {tag,url}[]
 *    - m2: string (y opcional m2_num: number)
 *    - vista: string
 *    - dormitorios: number|null
 *    - capacidad: number|null (y opcional capacidad_num derivada de caracteristicas.Capacidad)
 *    - source, createdAt, updatedAt
 *
 *  NOTAS DE DESPLIEGUE
 *  -------------------
 *  - Este endpoint llama a /api/SQLServerBackend?action=warmup y a
 *    /api/SQLServerBackend?action=properties&userId=1 usando la URL definida
 *    por PUBLIC_BASE_URL o VERCEL_URL.
 *  - Evita imprimir secretos en logs. La `api_key` se redacted como "***".
 *  - Si querés evitar almacenar `api_key` en Firestore, comentá esa línea.
 *  - Considerá limitar lotes/paginación si el origen crece en volumen.
 *
 * ============================================================================
 */

import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';

// ──────────────────────────────────────────────────────────────────────────────
// Inicialización Firebase Admin
// ─────────────────────────────────────────────────────────────────────────────-
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON || '{}');
if (!serviceAccount.project_id) {
  throw new Error('FIREBASE_SERVICE_ACCOUNT_JSON inválido o ausente.');
}
try {
  initializeApp({ credential: cert(serviceAccount) });
} catch {
  // Previene error "app already initialized" en dev/HMR.
}
const db = getFirestore();

// ──────────────────────────────────────────────────────────────────────────────
/** Helpers genéricos */
// ─────────────────────────────────────────────────────────────────────────────-
const CRON_SECRET = process.env.CRON_SECRET;

function getBaseUrl() {
  const BASE =
    process.env.PUBLIC_BASE_URL ||
    (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : null);
  if (!BASE || typeof BASE !== 'string') {
    throw new Error('PUBLIC_BASE_URL no está definido (ni VERCEL_URL).');
  }
  return BASE.startsWith('http') ? BASE : `https://${BASE}`;
}

function maskPropForLog(p) {
  const { api_key, ...rest } = p || {};
  return { ...rest, api_key: api_key ? '***' : undefined };
}

async function fetchJSON(url, opts = {}) {
  const { retries = 3, baseDelay = 800, timeoutMs = 12_000, method = 'GET', headers = {} } = opts;
  // cache-buster (solo en GET)
  const fullUrl = method === 'GET'
    ? (url + (url.includes('?') ? '&' : '?') + '_ts_=' + Date.now())
    : url;

  let lastErr;
  for (let attempt = 0; attempt < retries; attempt++) {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), timeoutMs);
    const t0 = Date.now();
    try {
      const res = await fetch(fullUrl, { method, headers, signal: controller.signal });
      clearTimeout(t);
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`Fetch ${fullUrl} -> HTTP ${res.status} ${res.statusText} ${text ? `| ${text.slice(0,180)}` : ''}`);
      }
      const json = await res.json();
      console.log(`⏱️ fetch ok ${fullUrl} in ${Date.now()-t0}ms`);
      return json;
    } catch (e) {
      clearTimeout(t);
      lastErr = e;
      const wait = baseDelay * Math.pow(2, attempt);
      console.log(`🔁 fetchJSON retry ${attempt + 1}/${retries} en ${wait}ms | ${e?.message || e}`);
      if (attempt < retries - 1) await new Promise(r => setTimeout(r, wait));
    }
  }
  throw lastErr;
}
function createBulkWriter() {
  const writer = db.bulkWriter();
  writer.onWriteError((err) => {
    if (err.failedAttempts < 3) {
      console.warn('⚠️ Retry BulkWriter por contención:', err.documentRef?.path, err.message);
      return true;
    }
    console.error('❌ BulkWriter sin retry:', err.documentRef?.path, err.message);
    return false;
  });
  return writer;
}

// Helpers para armar docs sin pisar con valores vacíos
const isDef = (v) => v !== undefined && v !== null;
const addIfDef = (obj, key, val) => { if (isDef(val)) obj[key] = val; };
const addIfObject = (obj, key, val) => { if (val && typeof val === 'object') obj[key] = val; };
const addIfArray  = (obj, key, val) => { if (Array.isArray(val)) obj[key] = val; };

// ─────────────────────────────────────────────────────────────────────────────-
export default async function handler(req, res) {
  const isProd = process.env.NODE_ENV === 'production';

  // Seguridad
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Método no permitido. Usá POST.' });
  }
  if (isProd && (!CRON_SECRET || req.headers['x-cron-secret'] !== CRON_SECRET)) {
    return res.status(401).json({ success: false, error: 'No autorizado.' });
  }

  // Body
  let body = {};
  try {
    body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
  } catch {
    body = {};
  }

  const { onlyPropertyId, bypassChatbotFilter = false } = body || {};
  const baseUrl = getBaseUrl();

  console.log('🔥 Iniciando exportación…', {
    onlyPropertyId: onlyPropertyId ?? null,
    bypassChatbotFilter: !!bypassChatbotFilter,
    baseUrl
  });

  // Warmup con retry (no bloquea si falla)
  try {
    await fetchJSON(`${baseUrl}/api/SQLServerBackend?action=warmup`, {
      retries: 3, baseDelay: 800, timeoutMs: 20_000
    });
    console.log('✅ Warmup OK');
  } catch (e) {
    console.warn('⚠️ Warmup falló (continuo igual):', e?.message || e);
  }

  // Obtener propiedades
  let propiedades = [];
  try {
    propiedades = await fetchJSON(
      `${baseUrl}/api/SQLServerBackend?action=properties&userId=1`,
      { retries: 5, baseDelay: 1200, timeoutMs: 40_000 }
    );
  } catch (e) {
    console.error('❌ No pude obtener propiedades:', e?.message || e);
    return res.status(502).json({ success: false, error: 'Fallo al obtener propiedades del backend SQL.' });
  }

  if (!Array.isArray(propiedades)) {
    return res.status(500).json({ success: false, error: 'El backend devolvió un formato inesperado (no es array).' });
  }

  if (onlyPropertyId != null) {
    const targetId = String(onlyPropertyId);
    propiedades = propiedades.filter(p => String(p?.property_id) === targetId);
    if (propiedades.length === 0) {
      return res.status(404).json({ success: false, error: `No se encontró la propiedad ${targetId}.` });
    }
  }

  // Escritura con BulkWriter
  const writer = createBulkWriter();

  const summary = {
    properties_total: propiedades.length,
    properties_written: 0,
    apartments_written: 0,
    skipped_by_chatbot_filter: 0,
    errors: []
  };

  for (const propiedad of propiedades) {
    try {
      // Filtro de chatbot a nivel propiedad
      if (!bypassChatbotFilter && propiedad?.chatbot !== 1) {
        summary.skipped_by_chatbot_filter++;
        continue;
      }

      const propId = String(propiedad.property_id);
      const propRef = db.collection('propiedades').doc(propId);

      // ── Construcción de documento de PROPIEDAD (sin pisar con vacíos)
      const propDoc = { source: 'exportToFirestore', updatedAt: FieldValue.serverTimestamp() };
      propDoc.createdAt = FieldValue.serverTimestamp();

      // Campos básicos (solo si vienen)
      addIfDef(propDoc, 'nombre', propiedad.property_name);
      addIfDef(propDoc, 'descripcion', propiedad.property_description);
      addIfDef(propDoc, 'api_key', propiedad.api_key);
      addIfDef(propDoc, 'short_name', propiedad.short_name);
      addIfDef(propDoc, 'chatbot_rate', isDef(propiedad.chatbot_rate) ? Number(propiedad.chatbot_rate) : undefined);

      // FALTANTES top-level de tu esquema real
      addIfDef(propDoc, 'activar_para_planillas_diarias', propiedad.activar_para_planillas_diarias);
      addIfDef(propDoc, 'activar_para_venta', propiedad.activar_para_venta);
      addIfDef(propDoc, 'estacionamiento', propiedad.estacionamiento);
      addIfDef(propDoc, 'mascotas', propiedad.mascotas);
      addIfDef(propDoc, 'wifi', propiedad.wifi);

      // Características & contenido extendido
      addIfObject(propDoc, 'caracteristicas', propiedad.caracteristicas);
      addIfDef(propDoc, 'descripcion_detallada', propiedad.descripcion_detallada);
      addIfArray(propDoc, 'faq', propiedad.faq);
      addIfDef(propDoc, 'tipo_viajero', propiedad.tipo_viajero);
      addIfDef(propDoc, 'historia', propiedad.historia);

      // Galería (no pisar con [])
      addIfArray(propDoc, 'galeria', propiedad.galeria);

      // Ubicación: aceptar objeto completo o subcampos sueltos
      if (propiedad.ubicacion && typeof propiedad.ubicacion === 'object') {
        propDoc.ubicacion = { ...(propiedad.ubicacion || {}) };
      } else {
        const ubic = {};
        addIfDef(ubic, 'direccion', propiedad?.ubicacion?.direccion ?? propiedad.direccion);
        addIfDef(ubic, 'lat', propiedad?.ubicacion?.lat ?? propiedad.lat);
        addIfDef(ubic, 'lng', propiedad?.ubicacion?.lng ?? propiedad.lng);
        addIfDef(ubic, 'zona', propiedad?.ubicacion?.zona ?? propiedad.zona);
        if (Object.keys(ubic).length) propDoc.ubicacion = ubic;
      }

      writer.set(propRef, propDoc, { merge: true });
      summary.properties_written++;
      console.log('🏢 Propiedad upsert:', JSON.stringify(maskPropForLog(propiedad)));

      // ── Departamentos
      const dptos = Array.isArray(propiedad.apartments) ? propiedad.apartments : [];
      for (const dpto of dptos) {
        try {
          // Filtro de chatbot a nivel dpto
          if (!bypassChatbotFilter && dpto?.chatbot !== 1) {
            summary.skipped_by_chatbot_filter++;
            continue;
          }

          const dptoId = String(dpto.apartment_id);
          const dptoRef = propRef.collection('departamentos').doc(dptoId);

          // Construcción de documento de DPTO
          const dptoDoc = { source: 'exportToFirestore', updatedAt: FieldValue.serverTimestamp() };
          dptoDoc.createdAt = FieldValue.serverTimestamp();

          addIfDef(dptoDoc, 'nombre', dpto.apartment_name);
          addIfDef(dptoDoc, 'descripcion', dpto.apartment_description);
          addIfDef(dptoDoc, 'wubook_shortname', dpto.apartment_wubook_shortname);
          addIfDef(dptoDoc, 'consulta', dpto.consulta);

          // FALTANTES top-level
          addIfDef(dptoDoc, 'activar_para_venta', dpto.activar_para_venta);

          // m2: conservar string, opcional m2_num numérico
          if (isDef(dpto.m2)) {
            addIfDef(dptoDoc, 'm2', String(dpto.m2));
            const m2n = Number(dpto.m2);
            if (Number.isFinite(m2n)) addIfDef(dptoDoc, 'm2_num', m2n);
          }

          addIfDef(dptoDoc, 'vista', dpto.vista);
          addIfDef(dptoDoc, 'dormitorios', isDef(dpto.dormitorios) ? Number(dpto.dormitorios) : undefined);
          addIfDef(dptoDoc, 'capacidad', isDef(dpto.capacidad) ? Number(dpto.capacidad) : undefined);

          // Características y contenido extendido
          addIfObject(dptoDoc, 'caracteristicas', dpto.caracteristicas);
          addIfArray(dptoDoc, 'faq', dpto.faq);
          addIfArray(dptoDoc, 'galeria', dpto.galeria);

          // Derivar capacidad_num desde caracteristicas.Capacidad si existe (string -> number)
          const capStr = dpto?.caracteristicas?.Capacidad;
          const capNum = Number(capStr);
          if (Number.isFinite(capNum)) addIfDef(dptoDoc, 'capacidad_num', capNum);

          writer.set(dptoRef, dptoDoc, { merge: true });
          summary.apartments_written++;
          console.log(`   🛏️ Dpto upsert: [${propId}/${dptoId}] ${dptoDoc.nombre || ''}`);
        } catch (e) {
          const msg = `Error escribiendo dpto property=${propiedad?.property_id} apartment=${dpto?.apartment_id}: ${e?.message || e}`;
          console.error('❌', msg);
          summary.errors.push(msg);
        }
      }
    } catch (e) {
      const msg = `Error escribiendo propiedad property=${propiedad?.property_id}: ${e?.message || e}`;
      console.error('❌', msg);
      summary.errors.push(msg);
    }
  }

  try {
    await writer.close();
  } catch (e) {
    const msg = `Error al cerrar BulkWriter: ${e?.message || e}`;
    console.error('❌', msg);
    summary.errors.push(msg);
  }

  const httpStatus = summary.errors.length ? 207 : 200;
  return res.status(httpStatus).json({
    success: summary.errors.length === 0,
    message: 'Exportación finalizada',
    summary
  });
}

