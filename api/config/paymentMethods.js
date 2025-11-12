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
    // init admin with application default credentials (works with GOOGLE_APPLICATION_CREDENTIALS or on Vercel with service account)
    if (!admin.apps.length) {
      try {
        admin.initializeApp({
          credential: admin.credential.applicationDefault(),
        });
      } catch (e) {
        // if initialize fails, continue and return fallback below
        console.warn("[paymentMethods] firebase admin init failed:", e?.message || e);
      }
    }

    if (!admin.apps.length) {
      // cannot access Firestore: return empty and let client fallback
      return res.status(200).json({ methods: [] });
    }

    const db = admin.firestore();
    const docRef = db.collection("configuracion").doc("metodos_de_pago");
    const snap = await docRef.get();
    if (!snap.exists) return res.status(200).json({ methods: [] });

    const data = snap.data() || {};

    // doc can be stored as { methods: [...] } or as indexed fields 0:"Efectivo",1:"Tarjeta",...
    let methods = [];
    if (Array.isArray(data.methods)) {
      methods = data.methods;
    } else {
      // take values ordered by numeric keys if present, otherwise object values
      const keys = Object.keys(data);
      if (keys.length === 0) methods = [];
      else if (keys.every(k => String(k).match(/^\d+$/))) {
        methods = keys.sort((a,b) => Number(a)-Number(b)).map(k => data[k]);
      } else {
        methods = Object.values(data);
      }
    }

    // normalize to strings
    methods = methods.map(m => (m === null || m === undefined) ? "" : String(m));
    return res.status(200).json({ methods });
  } catch (err) {
    console.error("[paymentMethods] error", err);
    return res.status(500).json({ methods: [] });
  }
}