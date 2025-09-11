// /lib/firebaseAdmin.js
import admin from "firebase-admin";

/**
 * Carga segura de credenciales desde una única env var:
 * FIREBASE_SERVICE_ACCOUNT_JSON = (pegar el JSON completo del Service Account)
 * Ejemplo de contenido:
 * {
 *   "type": "service_account",
 *   "project_id": "viproomer-core-prod",
 *   "private_key_id": "xxxxxxxx",
 *   "private_key": "-----BEGIN PRIVATE KEY-----\nMIIE...==\n-----END PRIVATE KEY-----\n",
 *   "client_email": "firebase-adminsdk-xxx@viproomer-core-prod.iam.gserviceaccount.com",
 *   "client_id": "1234567890",
 *   ...
 * }
 */
function getCredentialsFromEnv() {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (!raw) {
    throw new Error("FIREBASE_SERVICE_ACCOUNT_JSON no está definida");
  }

  let json;
  try {
    json = JSON.parse(raw);
  } catch (e) {
    // Si vino minificado/escapado, intentamos normalizar saltos de línea en la private_key
    try {
      const tmp = JSON.parse(raw.replace(/\\n/g, "\n"));
      json = {
        ...tmp,
        private_key: (tmp.private_key || "").replace(/\\n/g, "\n"),
      };
    } catch (e2) {
      throw new Error("FIREBASE_SERVICE_ACCOUNT_JSON inválida (no es JSON)");
    }
  }

  // Asegura que la private_key tenga saltos de línea reales
  if (json.private_key && typeof json.private_key === "string") {
    json.private_key = json.private_key.replace(/\\n/g, "\n");
  }
  return json;
}

// Inicializa Admin SDK una sola vez (reutilizable entre endpoints)
if (!admin.apps.length) {
  const creds = getCredentialsFromEnv();
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: creds.project_id,
      clientEmail: creds.client_email,
      privateKey: creds.private_key,
    }),
    // databaseURL: "https://<tu-project-id>.firebaseio.com", // <-- solo si usaras RTDB
  });
}

// Exports útiles en endpoints
export const firestore = admin.firestore();
export const FieldValue = admin.firestore.FieldValue;
export const Timestamp = admin.firestore.Timestamp;
export const authAdmin = admin.auth();
// (si necesitás Storage más adelante)
// export const storage = admin.storage();