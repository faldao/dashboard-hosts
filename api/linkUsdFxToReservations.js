/**
 * /api/linkUsdFxToReservations.js
 * ──────────────────────────────────────────────────────────────────────────────
 * PROPÓSITO
 *   Proceso INDEPENDIENTE que "linkea" (anota) la cotización USD del día de
 *   check-in en cada documento de la colección `Reservas`.
 *
 *   La fuente NO es una API externa, sino las cotizaciones ya persistidas en
 *   Firestore por tu endpoint de cotizaciones:
 *     cotizaciones / USD / yyyy / mm / dd / cot
 *
 *   Para cada reserva con `arrival_iso == YYYY-MM-DD`, se escribe:
 *     usd_fx_on_checkin: {
 *       casa, fecha, compra, venta,
 *       fuente: "cotizaciones:firestore",
 *       setAt: serverTimestamp()
 *     }
 *
 *   Solo se escribe si el campo NO existe (idempotente) o si `force=true`.
 *
 * ESTRATEGIA GENERAL
 *   1) Consulta/usa un meta de progreso: `cotizaciones_meta / USD`
 *        { lastQuoteDate: "YYYY-MM-DD", lastLinkedDate: "YYYY-MM-DD" }
 *
 *      - `lastQuoteDate` es la última fecha con cotización USD guardada.
 *         → Se mantiene al día desde tu endpoint /api/dolarByDate.js
 *         → Si no existe, se infiere buscando hacia atrás (hasta 365 días).
 *      - `lastLinkedDate` es la última fecha hasta la que linkeaste reservas.
 *
 *   2) Determina un rango a procesar:
 *      - Si el request pasa `since`/`until`, usa ese rango (acotado a hoy y
 *        a `lastQuoteDate`).
 *      - Si NO, usa:
 *            start = lastLinkedDate + 1    (o  lastQuoteDate - backfillDays  si no hay lastLinkedDate)
 *            end   = min(hoy, lastQuoteDate)
 *
 *   3) Para cada fecha del rango:
 *      - Lee cotización en `cotizaciones/USD/yyyy/mm/dd/cot`
 *      - Si no hay cotización → marca `no_quote` para ese día.
 *      - Si hay, busca reservas:
 *            Reservas.where("arrival_iso","==",fechaISO)
 *            (opcional) .where("propiedad_id","in",[...]) en sublotes de 10
 *        • Pagina de a `pageSize` docs (default 500)
 *        • Escribe `usd_fx_on_checkin` si no existe o si `force=true`
 *
 *   4) Al finalizar, si `dryRun=false`, actualiza `cotizaciones_meta/USD.lastLinkedDate = end`.
 *
 * PARÁMETROS (query o body, GET/POST)
 *   - since=YYYY-MM-DD       Inicio del rango (opcional)
 *   - until=YYYY-MM-DD       Fin del rango (opcional, default: hoy)
 *   - propertyIds=100,101    Filtro opcional de propiedades (se procesa en sublotes de 10 p/consulta)
 *   - force=true|false       Reescribe aunque ya exista `usd_fx_on_checkin` (default: false)
 *   - dryRun=true|false      No escribe, solo simula. (default: true)
 *   - pageSize=500           Lecturas por página de reservas (50..1000)
 *   - backfillDays=7         Backfill inicial si no hay lastLinkedDate (0..60, default: 7)
 *
 * RESPUESTA (resumen)
 *   {
 *     ok: true,
 *     dryRun, force,
 *     range: { start, end },
 *     lastQuoteDate,
 *     lastLinkedDateBefore,
 *     propertyIdsCount,
 *     totals: {
 *       dates, updated, matched, skippedExisting, no_quote_days
 *     },
 *     perDate: [
 *       { date, status: "ok", matched, skippedExisting, updated }
 *       | { date, status: "no_quote" }
 *     ]
 *   }
 *
 * EJEMPLOS
 *   • Dry-run automático (usa meta):
 *       GET  /api/linkUsdFxToReservations
 *
 *   • Ejecutar con escritura real:
 *       POST /api/linkUsdFxToReservations
 *       { "dryRun": false }
 *
 *   • Rango específico + propiedades:
 *       GET  /api/linkUsdFxToReservations?since=2025-08-01&until=2025-09-30&propertyIds=100,106&dryRun=false
 *
 *   • Forzar reescritura aunque ya exista:
 *       GET  /api/linkUsdFxToReservations?force=true&dryRun=false
 *
 * CRON SUGERIDO
 *   - Diario 10:15 AR (después de persistir cotizaciones): /api/linkUsdFxToReservations?dryRun=false
 *   - (Opcional) refuerzo 13:15 AR.
 *
 * NOTAS
 *   - Este proceso NO genera nuevas cotizaciones; solo linkea desde lo que ya
 *     existe en Firestore. Asegurate de correr /api/dolarByDate.js antes.
 *   - Pensado para correr repetidamente sin duplicar trabajo (idempotente).
 * ──────────────────────────────────────────────────────────────────────────────
 */

import { firestore, FieldValue } from "../lib/firebaseAdmin.js";
import { DateTime } from "luxon";

const TZ = "America/Argentina/Buenos_Aires";
const log = (...xs) => console.log("[LinkFX]", ...xs);

// ── HTTP helpers ─────────────────────────────────────────────────────────────
function ok(res, data) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  return res.status(200).json(data);
}
function bad(res, code, error) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  return res.status(code).json({ error });
}

// ── Utils de fecha ───────────────────────────────────────────────────────────
const toISO = (s) => {
  const d = DateTime.fromISO(String(s || ""), { zone: TZ });
  return d.isValid ? d.toISODate() : null;
};

// ── Lectura de cotización desde Firestore ────────────────────────────────────
async function getQuoteDoc(dateISO) {
  // Ruta: cotizaciones/USD/yyyy/mm/dd/cot
  const d = DateTime.fromISO(dateISO, { zone: TZ });
  const yyyy = d.toFormat("yyyy");
  const mm = d.toFormat("MM");
  const dd = d.toFormat("dd");
  const ref = firestore
    .collection("cotizaciones").doc("USD")
    .collection(yyyy).doc(mm)
    .collection(dd).doc("cot");
  const snap = await ref.get();
  return snap.exists ? { id: ref.path, ...snap.data() } : null;
}

// Busca la última fecha (<= hoy) que tiene cotización en Firestore.
// Recorre hacia atrás hasta maxLookbackDays (default 365).
async function findLastQuoteDateFromFirestore(maxLookbackDays = 365) {
  for (let i = 0; i <= maxLookbackDays; i++) {
    const d = DateTime.now().setZone(TZ).minus({ days: i }).toISODate();
    const q = await getQuoteDoc(d);
    if (q && Number.isFinite(Number(q.venta))) {
      return d;
    }
  }
  return null;
}

// ── Meta de progreso ─────────────────────────────────────────────────────────
async function readMeta() {
  const ref = firestore.collection("cotizaciones_meta").doc("USD");
  const snap = await ref.get();
  return snap.exists ? { ref, data: snap.data() || {} } : { ref, data: {} };
}
async function writeMeta(update) {
  const { ref } = await readMeta();
  await ref.set(
    { ...update, updatedAt: FieldValue.serverTimestamp() },
    { merge: true }
  );
}

// ── Iterador de fechas inclusivo ─────────────────────────────────────────────
function* dateRangeIterator(startISO, endISO) {
  let d = DateTime.fromISO(startISO, { zone: TZ }).startOf("day");
  const end = DateTime.fromISO(endISO, { zone: TZ }).startOf("day");
  while (d <= end) {
    yield d.toISODate();
    d = d.plus({ days: 1 });
  }
}

// ── Actualiza reservas de una fecha dada ─────────────────────────────────────
async function updateReservationsForDate({
  dateISO,
  quote,
  propertyIds,
  force,
  dryRun,
  pageSize = 500,
}) {
  const baseQuery = firestore.collection("Reservas")
    .where("arrival_iso", "==", dateISO);

  // Firestore 'in' soporta hasta 10 valores. Si hay más, dividimos en sublotes.
  const chunks = [];
  if (Array.isArray(propertyIds) && propertyIds.length > 0) {
    const sliceSize = 10;
    for (let i = 0; i < propertyIds.length; i += sliceSize) {
      chunks.push(propertyIds.slice(i, i + sliceSize));
    }
  } else {
    chunks.push(null); // sin filtro de propiedades
  }

  let totalMatched = 0;
  let totalSkippedExisting = 0;
  let totalUpdated = 0;

  log("DATE START", {
    dateISO,
    dryRun,
    force,
    propertyIdsCount: Array.isArray(propertyIds) ? propertyIds.length : 0,
    pageSize
  });

  for (const sub of chunks) {
    let q = baseQuery;
    if (Array.isArray(sub)) {
      q = q.where("propiedad_id", "in", sub);
    }

    log("CHUNK", {
      dateISO,
      filterPropIds: Array.isArray(sub) ? sub : "ALL"
    });

    let cursor = null;
    while (true) {
      // Con startAfter(docSnapshot) Firestore usa el orden por __name__ implícito.
      let qry = q.limit(pageSize);
      if (cursor) qry = qry.startAfter(cursor);

      const snap = await qry.get();
      if (snap.empty) {
        log("PAGE", { dateISO, page: "empty" });
        break;
      }

      log("PAGE", {
        dateISO,
        pageSize: snap.size,
        matchedSoFar: totalMatched
      });

      let batch = firestore.batch();
      let ops = 0;

      for (const doc of snap.docs) {
        totalMatched++;
        const d = doc.data() || {};
        const already = d.usd_fx_on_checkin;

        if (already && !force) {
          totalSkippedExisting++;
          continue;
        }

        if (dryRun) {
          totalUpdated++; // contamos el potencial update
          continue;
        }

        const payload = {
          usd_fx_on_checkin: {
            casa: (quote.casa || "oficial").toString().toLowerCase(),
            fecha: dateISO,
            compra: Number(quote.compra ?? null),
            venta: Number(quote.venta ?? null),
            fuente: "cotizaciones:firestore",
            setAt: FieldValue.serverTimestamp(),
          },
          updatedAt: FieldValue.serverTimestamp(),
        };

        batch.set(doc.ref, payload, { merge: true });
        ops++;
        totalUpdated++;

        if (ops >= 450) {
          log("BATCH FLUSH", { dateISO, ops });
          await batch.commit();
          batch = firestore.batch();
          ops = 0;
        }
      }

      if (!dryRun && ops > 0) await batch.commit();

      cursor = snap.docs[snap.docs.length - 1];
      if (snap.size < pageSize) break; // última página
    }
  }

  log("DATE DONE", {
    dateISO,
    matched: totalMatched,
    skippedExisting: totalSkippedExisting,
    updated: totalUpdated
  });

  return { dateISO, matched: totalMatched, skippedExisting: totalSkippedExisting, updated: totalUpdated };
}

// ── Handler ──────────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  try {
    if (req.method === "OPTIONS") return ok(res, { ok: true });
    if (req.method !== "GET" && req.method !== "POST") {
      return bad(res, 405, "Método no permitido");
    }

    const q = req.method === "GET" ? req.query : (req.body || {});
    const since = toISO(q.since);
    const untilInput = toISO(q.until);
    const force = String(q.force).toLowerCase() === "true";
    const dryRun = q.dryRun === undefined ? true : String(q.dryRun).toLowerCase() === "true";
    const pageSize = Math.max(50, Math.min(1000, Number(q.pageSize) || 500));
    const backfillDays = Math.max(0, Math.min(60, Number(q.backfillDays) || 7));

    const propertyIds =
      typeof q.propertyIds === "string"
        ? q.propertyIds.split(",").map(s => s.trim()).filter(Boolean)
        : Array.isArray(q.propertyIds) ? q.propertyIds : [];

    // Meta actual
    const meta = await readMeta();
    const lastLinkedDate = meta.data.lastLinkedDate || null;

    // Última fecha con cotización (idealmente mantenida por /api/dolarByDate.js)
    let lastQuoteDate = meta.data.lastQuoteDate || null;
    if (!lastQuoteDate) {
      lastQuoteDate = await findLastQuoteDateFromFirestore(365);
    }
    if (!lastQuoteDate) {
      return bad(res, 400, "No se encontraron cotizaciones USD en Firestore (cotizaciones/USD/...)");
    }

    // Determinar rango efectivo
    let start =
      since ||
      (lastLinkedDate
        ? DateTime.fromISO(lastLinkedDate, { zone: TZ }).plus({ days: 1 }).toISODate()
        : DateTime.fromISO(lastQuoteDate, { zone: TZ }).minus({ days: backfillDays }).toISODate());

    let end = untilInput || DateTime.now().setZone(TZ).toISODate();

    // Acotar a límites válidos (no procesar futuro ni después de lastQuoteDate)
    const today = DateTime.now().setZone(TZ).toISODate();
    if (end > today) end = today;
    if (end > lastQuoteDate) end = lastQuoteDate;
    if (start > end) {
      return ok(res, {
        ok: true,
        reason: "No work",
        range: { start, end },
        lastQuoteDate,
        lastLinkedDateBefore: lastLinkedDate || null,
        dryRun,
      });
    }

    log("INIT", {
      start,
      end,
      dryRun,
      force,
      propertyIdsCount: propertyIds.length,
      pageSize
    });

    const perDate = [];
    for (const d of dateRangeIterator(start, end)) {
      const qd = await getQuoteDoc(d);
      if (!qd) {
        perDate.push({ date: d, status: "no_quote" });
        continue;
      }
      const r = await updateReservationsForDate({
        dateISO: d,
        quote: qd,
        propertyIds,
        force,
        dryRun,
        pageSize,
      });
      perDate.push({
        date: d,
        status: "ok",
        matched: r.matched,
        skippedExisting: r.skippedExisting,
        updated: r.updated
      });
    }

    // Actualizamos meta.lastLinkedDate si no es dryRun
    if (!dryRun) {
      await writeMeta({
        lastLinkedDate: end,
        lastQuoteDate, // opcional registrar también por consistencia
      });
    }

    const summary = {
      ok: true,
      dryRun,
      force,
      range: { start, end },
      lastQuoteDate,
      lastLinkedDateBefore: lastLinkedDate || null,
      propertyIdsCount: propertyIds.length,
      totals: {
        dates: perDate.length,
        updated: perDate.reduce((s, x) => s + (x.updated || 0), 0),
        matched: perDate.reduce((s, x) => s + (x.matched || 0), 0),
        skippedExisting: perDate.reduce((s, x) => s + (x.skippedExisting || 0), 0),
        no_quote_days: perDate.filter(x => x.status === "no_quote").length,
      },
      perDate,
    };

    log("DONE", { range: { start, end }, totals: summary.totals });

    return ok(res, summary);
  } catch (e) {
    console.error(e);
    return bad(res, 500, e.message || "Error interno");
  }
}
