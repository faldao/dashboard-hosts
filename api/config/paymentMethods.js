import admin from "firebase-admin";

const setCors = (res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
};

export default async function handler(req, res) {
  setCors(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ error: "method not allowed" });

  try {
    // intentar cargar el helper central que inicializa admin con FIREBASE_SERVICE_ACCOUNT_JSON
    let db = null;
    try {
      const mod = await import("../../lib/firebaseAdmin.js");
      db = mod.firestore;
    } catch (e) {
      console.warn("[paymentMethods] could not init firebaseAdmin helper:", e?.message || e);
    }

    if (!db) {
      // no credentials/config disponibles -> devolver vacío (cliente usará fallback)
      console.warn("[paymentMethods] no Firestore available - returning empty methods");
      return res.status(200).json({ methods: [] });
    }

    // ahora usamos el firestore exportado por lib/firebaseAdmin
    const docRef = db.collection("configuracion").doc("metodos_de_pago");
    const snap = await docRef.get();
    if (!snap.exists) return res.status(200).json({ methods: [] });

    const data = snap.data();

    // Manejo robusto: el documento puede ser:
    // - directamente un array (unlikely pero manejado)
    // - { methods: [ ... ] }
    // - campos indexados 0:"Efectivo",1:"Tarjeta",...
    // - object con values como lista concatenada en una única cadena
    let methods = [];

    if (Array.isArray(data)) {
      // documento leído como array
      methods = data.slice();
    } else if (Array.isArray(data.methods)) {
      methods = data.methods.slice();
    } else {
      // si el doc tiene una sola clave cuyo valor es un array, úsalo
      const vals = Object.values(data || {});
      if (vals.length === 1 && Array.isArray(vals[0])) {
        methods = vals[0].slice();
      } else {
        const keys = Object.keys(data || {});
        if (keys.length === 0) {
          methods = [];
        } else if (keys.every(k => String(k).match(/^\d+$/))) {
          methods = keys.sort((a,b) => Number(a)-Number(b)).map(k => data[k]);
        } else {
          methods = Object.values(data || {});
        }
      }
    }

    // normalize to strings
    methods = methods.map(m => (m === null || m === undefined) ? "" : String(m).trim()).filter(Boolean);

    // Si quedó como una única cadena con separadores, dividirla en múltiples opciones
    if (methods.length === 1 && typeof methods[0] === "string" && /[,;\r\n]/.test(methods[0])) {
      methods = methods[0].split(/[,;\r\n]+/).map(s => s.trim()).filter(Boolean);
    }

    return res.status(200).json({ methods });
  } catch (err) {
    console.error("[paymentMethods] error", err);
    return res.status(500).json({ methods: [] });
  }
}