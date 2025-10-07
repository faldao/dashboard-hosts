/*
 * /api/wubookImportByArrival.js
 * ─────────────────────────────────────────────────────────────────────────────
 * OBJETIVO
 *   Importar reservas de WuBook por rango de llegada (arrival date), crear/actualizar
 *   documentos en Firestore (colección `Reservas`) por HABITACIÓN (room), y dejar
 *   historial de cambios. El prorrateo de EXTRAS se hace AQUÍ (en el import),
 *   de modo que el “enrich” no recalcula.
 *
 * FLUJO RESUMIDO
 *   1) Trae reservas con KP: /reservations/fetch_reservations (paginado) usando filtros { arrival: { from, to } }.
 *   2) Filtra canceladas.
 *   3) Por cada reserva:
 *       • Calcula una sola vez: roomsCountRaw, extrasUSDTotalRaw, extrasUSDPerRoomRaw.
 *       • Itera rooms; mapea contra `prop.roomMap` (id_zak_room → código_depto).
 *       • Construye/actualiza un doc por room con:
 *           - id: `${prop.id}_${id_human}_${id_zak}`
 *           - wubook_price (amount pre-IVA, vat, total, currency)
 *           - toPay_breakdown (preserva campos host si existen)
 *           - toPay (solo si no estaba)
 *           - extrasUSD (solo si no estaba): usa extrasUSDPerRoomRaw (import decide)
 *           - Meta cruda: wubook_rooms_count, wubook_extrasUSD_total, wubook_extrasUSD_perRoom
 *       • Escribe historial en subcolección `historial`.
 *   4) Batch con límite seguro (≈450 ops).
 *
 * REQUEST
 *   Método: POST (también GET para tests), CORS abierto
 *   Body (JSON):
 *     - propertyIds?: string[]        // si se omite, usa "propiedades activas"
 *     - fromDate?: string             // 'dd/MM/yyyy' (si falta, usa modo auto: mañana/pasado)
 *     - toDate?: string               // 'dd/MM/yyyy' (si falta, 31/12/2099)
 *     - dryRun?: boolean              // true = no escribe, solo simula
 *
 * RESPUESTA (200)
 *   {
 *     ok: true,
 *     summary: [{
 *       propiedad: { id, nombre },
 *       mode: 'manual' | 'auto_future_sync',
 *       range: { from, to },
 *       total_found: number,          // reservas crudas devueltas por WuBook
 *       upserts: number,              // docs creados/actualizados
 *       skipped: number,              // rooms que se saltaron (sin map/fechas/etc.)
 *       skipped_cancelled: number,    // reservas canceladas filtradas
 *       unchanged: number,            // docs sin cambios (hash igual)
 *       dryRun: boolean
 *     }, ...]
 *   }
 *
 * ESCRITURAS EN FIRESTORE (colección `Reservas`)
 *   - Doc-ID: `${prop.id}_${id_human}_${id_zak}`
 *   - Campos clave:
 *       id_human                     Ej: 'AP-0053'
 *       rsrvid                       Id numérico de WuBook (si viene)
 *       propiedad_id / propiedad_nombre
 *       id_zak, codigo_depto, depto_nombre
 *       arrival, arrival_iso, departure, departure_iso
 *       adults, children
 *       status (normalizado), is_cancelled (false aquí)
 *       wubook_price: { amount, vat, total, currency }   // por room
 *       currency: 'USD' | undefined
 *       toPay (si no estaba)
 *       toPay_breakdown: { baseUSD, ivaPercent, ivaUSD, extrasUSD, fxRate? }
 *       extrasUSD (top-level, si no estaba): extrasUSDPerRoomRaw
 *       // Metadatos crudos que fijan el prorrateo en el import:
 *       wubook_rooms_count
 *       wubook_extrasUSD_total
 *       wubook_extrasUSD_perRoom
 *       createdAt, updatedAt, contentHash
 *       enrichmentStatus: 'pending' (solo al crear)
 *
 * TIMEZONE
 *   - Toda conversión de fechas EU → ISO usa Luxon con TZ fija 'America/Argentina/Buenos_Aires'.
 *
 * IDEMPOTENCIA
 *   - Se usa `contentHash` (sha1 del doc sin campos volátiles) para evitar escrituras si no hay cambios.
 *   - Los campos editados por host NO se pisan si ya existen (preserve semantics).
 *
 * SEGURIDAD / CONFIG
 *   - Requiere que `getPropertiesAndRoomMaps()` provea `apiKey` y `roomMap` por propiedad.
 *   - Env required: `WUBOOK_BASE_URL` (opcional, default KP).
 *
 * ERRORES (4xx/5xx)
 *   - 400: no hay propiedades válidas / api_key
 *   - 405: método no permitido
 *   - 500: error interno (log detallado en server)
 *
 * EJEMPLOS
 *   curl -X POST https://<app>/api/wubookImportByArrival \
 *     -H "Content-Type: application/json" \
 *     -d '{
 *       "propertyIds":["106"],
 *       "fromDate":"08/10/2025",
 *       "toDate":"11/10/2025",
 *       "dryRun": false
 *     }'*/
 
import { DateTime } from 'luxon';
import { getPropertiesAndRoomMaps } from '../lib/fetchPropertiesAndRoomMaps.js';
import { TZ, fetchByArrivalRange, upsertReservations } from '../lib/importProcessShared.js';

const log = (...a) => console.log('[ImportByArrival]', ...a);

const ok = (res, data) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  return res.status(200).json(data);
};
const bad = (res, code, error) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  return res.status(code).json({ error });
};

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return ok(res, { ok: true });
  if (req.method !== 'POST' && req.method !== 'GET') return bad(res, 405, 'Método no permitido');

  try {
    const { propertyIds, dryRun = false } = (req.body && req.method === 'POST') ? req.body : {};
    let { fromDate, toDate } = (req.body && req.method === 'POST') ? req.body : {};
    let mode = 'manual';

    if (!fromDate) {
      mode = 'auto_future_sync';
      const now = DateTime.now().setZone(TZ);
      fromDate = now.plus({ days: 1 }).toFormat('dd/LL/yyyy');
      toDate   = now.plus({ days: 2 }).toFormat('dd/LL/yyyy');
      log(`Modo automático: ${fromDate} - ${toDate}`);
    } else if (!toDate) {
      toDate = '31/12/2099';
    }

    const propiedades = await getPropertiesAndRoomMaps({ propertyIds, onlyActiveIfNoIds: true, log });
    if (!propiedades.length) return bad(res, 400, 'No se encontraron propiedades con api_key válidas.');

    const summary = [];
    for (const prop of propiedades) {
      log('PROP START', { id: prop.id, nombre: prop.nombre });

      const reservas = await fetchByArrivalRange({ apiKey: prop.apiKey, fromDate, toDate, log });
      const result = await upsertReservations({
        reservas,
        prop,
        dryRun,
        sourceTag: 'wubookImportByArrival',
        log
      });

      summary.push({
        propiedad: { id: prop.id, nombre: prop.nombre },
        mode,
        range: { from: fromDate, to: toDate },
        total_found: reservas.length,
        ...result,
        dryRun
      });

      log('PROP DONE', summary[summary.length - 1]);
    }

    return ok(res, { ok: true, summary });
  } catch (err) {
    log('ERROR', err?.message); console.error(err);
    return bad(res, 500, err?.message || 'Error interno');
  }
}





