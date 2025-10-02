/**
 * ============================================================================
 * /api/exportJsonToFirestore.js
 * Migración desde archivo JSON local -> Firestore (propiedades y dptos)
 * ============================================================================
 *
 * RESUMEN
 * -------
 * Este endpoint lee un archivo JSON llamado `guemes.json` desde la raíz
 * del proyecto y sincroniza su contenido con Firestore. Es ideal para
 * migraciones controladas sin dependencias de red a un backend SQL.
 *
 * CÓMO USAR
 * ----------
 * 1. Colocá tu archivo `guemes.json` en la raíz de tu proyecto Vercel.
 * 2. Hacé un deploy.
 * 3. Hacé una petición POST a este endpoint.
 *
 * curl -X POST "https://<tu-app>/api/exportJsonToFirestore" \
 * -H "Content-Type: application/json" \
 * -H "x-cron-secret: <tu-secret>" \
 * -d '{}'
 *
 * VARIABLES DE ENTORNO (ENV)
 * --------------------------
 * - FIREBASE_SERVICE_ACCOUNT_JSON  (OBLIGATORIA)
 * - CRON_SECRET                      (OBLIGATORIA en prod)
 *
 * ============================================================================
 */

/*
 * ============================================================================
 *
 * RESUMEN
 * -------
 * Versión modificada para asegurar una estructura de datos completa.
 * Este endpoint lee `guemes.json` y crea cada propiedad y departamento
 * con un esquema predefinido, rellenando con valores nulos o vacíos
 * los campos que no se encuentren en el archivo JSON.
 *
 * ============================================================================
 */



/**
 * ============================================================================
 * /api/exportJsonToFirestore.js
 * Migración desde archivo JSON local -> Firestore (propiedades y dptos)
 * ============================================================================
 *
 * RESUMEN
 * -------
 * Versión final con mapeo de campos.
 * Este script lee `guemes.json`, traduce los nombres de los campos
 * (ej: `property_name` -> `nombre`) y luego asegura que cada documento
 * se cree con un esquema completo y consistente en Firestore.
 *
 * ============================================================================
 */

import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import path from 'path';
import fs from 'fs/promises';

// --- (Inicialización de Firebase Admin - sin cambios) ---
try {
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON || '{}');
  if (!serviceAccount.project_id) {
    throw new Error('FIREBASE_SERVICE_ACCOUNT_JSON no es válido o no está definido.');
  }
  initializeApp({ credential: cert(serviceAccount) });
} catch (e) {
  if (!/already exists/i.test(e.message)) {
    console.error('Fallo al inicializar Firebase Admin:', e);
  }
}
const db = getFirestore();

// --- (Helpers - sin cambios) ---
const CRON_SECRET = process.env.CRON_SECRET;
function createBulkWriter() {
  const writer = db.bulkWriter();
  writer.onWriteError((err) => {
    if (err.failedAttempts < 3) {
      console.warn(`⚠️ Reintentando escritura para ${err.documentRef?.path}: ${err.message}`);
      return true;
    }
    console.error(`❌ Error final de BulkWriter para ${err.documentRef?.path}: ${err.message}`);
    return false;
  });
  return writer;
}

// --- (Esquemas Completos - sin cambios) ---
const propertySchema = {
    nombre: null,
    descripcion: null,
    api_key: null,
    short_name: null,
    chatbot_rate: null,
    activar_para_planillas_diarias: false,
    activar_para_venta: false,
    estacionamiento: null,
    mascotas: null,
    wifi: null,
    galeria: [],
    caracteristicas: {},
    descripcion_detallada: null,
    faq: [],
    tipo_viajero: null,
    historia: null,
    ubicacion: {
        direccion: null,
        lat: null,
        lng: null,
        zona: null
    },
};
const apartmentSchema = {
    nombre: null,
    descripcion: null,
    wubook_shortname: null,
    consulta: null,
    activar_para_venta: false,
    caracteristicas: {},
    faq: [],
    galeria: [],
    m2: null,
    m2_num: null,
    vista: null,
    dormitorios: null,
    capacidad: null,
    capacidad_num: null,
};


// -----------------------------------------------------------------------------
// Handler Principal del Endpoint
// -----------------------------------------------------------------------------
export default async function handler(req, res) {
  // --- (Seguridad y Lectura de JSON - sin cambios) ---
  if (req.method !== 'POST') return res.status(405).json({ success: false, error: 'Método no permitido. Usá POST.' });
  const isProd = process.env.NODE_ENV === 'production';
  if (isProd && req.headers['x-cron-secret'] !== CRON_SECRET) return res.status(401).json({ success: false, error: 'No autorizado.' });

  let propiedadesJson;
  try {
    const jsonPath = path.join(process.cwd(), 'guemes.json');
    const fileContent = await fs.readFile(jsonPath, 'utf8');
    propiedadesJson = JSON.parse(fileContent);
    if (!Array.isArray(propiedadesJson)) throw new Error('El contenido del JSON no es un array.');
    console.log(`✅ Archivo guemes.json leído. Se encontraron ${propiedadesJson.length} propiedades.`);
  } catch (error) {
    return res.status(500).json({ success: false, error: 'No se pudo leer el archivo guemes.json.', details: error.message });
  }

  // --- Proceso de Escritura en Firestore ---
  const writer = createBulkWriter();
  const summary = {
    properties_read: propiedadesJson.length,
    properties_written: 0,
    apartments_written: 0,
    errors: [],
  };

  for (const propJson of propiedadesJson) {
    try {
      if (!propJson.property_id) {
          summary.errors.push('Se encontró una propiedad sin "property_id". Saltando...');
          continue;
      }

      const propId = String(propJson.property_id);
      const propRef = db.collection('propiedades').doc(propId);
      
      // --- NUEVO: MAPEO DE CAMPOS DE PROPIEDAD ---
      // Traducimos los nombres del JSON a los nombres del esquema de Firestore.
      const datosPropMapeados = {
        ...propJson, // Copiamos todos los campos por si algunos coinciden
        nombre: propJson.property_name,
        descripcion: propJson.property_description,
        // ... aquí podrías agregar más mapeos si hicieran falta
      };
      
      const { apartments, ...restOfPropData } = datosPropMapeados;
      
      const propDoc = {
        ...propertySchema,
        ...restOfPropData,
        source: 'json-import-mapped',
        updatedAt: FieldValue.serverTimestamp(),
      };
      
      writer.set(propRef, propDoc, { merge: true });
      summary.properties_written++;

      // Procesar subcolección de departamentos si existe
      if (Array.isArray(apartments)) {
        for (const dptoJson of apartments) {
          try {
            if (!dptoJson.apartment_id) {
                summary.errors.push(`Propiedad ${propId} tiene un dpto sin "apartment_id". Saltando...`);
                continue;
            }
            const dptoId = String(dptoJson.apartment_id);
            const dptoRef = propRef.collection('departamentos').doc(dptoId);

            // --- NUEVO: MAPEO DE CAMPOS DE DEPARTAMENTO ---
            const datosDptoMapeados = {
                ...dptoJson,
                nombre: dptoJson.apartment_name,
                descripcion: dptoJson.apartment_description,
                wubook_shortname: dptoJson.apartment_wubook_shortname,
            };

            const dptoDoc = {
                ...apartmentSchema,
                ...datosDptoMapeados,
                source: 'json-import-mapped',
                updatedAt: FieldValue.serverTimestamp(),
            };

            writer.set(dptoRef, dptoDoc, { merge: true });
            summary.apartments_written++;

          } catch (dptoError) {
             const msg = `Error escribiendo dpto ${dptoJson?.apartment_id} para prop ${propId}: ${dptoError.message}`;
             console.error('❌', msg);
             summary.errors.push(msg);
          }
        }
      }

    } catch (propError) {
      const msg = `Error procesando propiedad ${propJson?.property_id}: ${propError.message}`;
      console.error('❌', msg);
      summary.errors.push(msg);
    }
  }
  
  // --- (Finalizar y responder - sin cambios) ---
  try {
    await writer.close();
    console.log('✅ Escritura en BulkWriter finalizada.');
  } catch (e) {
    const msg = `Error al cerrar BulkWriter: ${e.message}`;
    console.error('❌', msg);
    summary.errors.push(msg);
  }

  const httpStatus = summary.errors.length > 0 ? 207 : 200;
  return res.status(httpStatus).json({
    success: summary.errors.length === 0,
    message: 'Importación desde JSON con mapeo de campos finalizada.',
    summary,
  });
}