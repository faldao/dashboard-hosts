/**
 * /api/wubookSyncToday.js
 * ─────────────────────────────────────────────────────────────────────────────
 * OBJETIVO
 *   Sincronizar “las reservas del día” según WuBook (arrivals, in-house, departures)
 *   y escribir/actualizar docs en `Reservas` por HABITACIÓN (room), dejando historial.
 *   Igual que el import por rango, EL PRORRATEO DE EXTRAS SUCEDE AQUÍ (import/sync),
 *   no en el enrich.
 *
 * DIFERENCIA PRINCIPAL VS ImportByArrival
 *   - La fuente de datos es KP `/reservations/fetch_today_reservations` (sin filtros).
 *   - El resto del flujo de escritura es compartido vía `importProcessShared.upsertReservations()`.
 *
 * REQUEST
 *   Método: POST (también GET), CORS abierto
 *   Body (JSON):
 *     - propertyIds?: string[]        // si se omite, usa "propiedades activas"
 *     - dryRun?: boolean              // true = no escribe, solo simula
 *
 * RESPUESTA (200)
 *   {
 *     ok: true,
 *     summary: [{
 *       propiedad: { id, nombre },
 *       found_today: number,          // reservas crudas del endpoint "today"
 *       upserts: number,
 *       skipped: number,
 *       skipped_cancelled: number,
 *       unchanged: number,
 *       dryRun: boolean
 *     }, ...]
 *   }
 *
 * ESCRITURAS EN FIRESTORE (colección `Reservas`)
 *   - Idem import por arrival: doc por room con:
 *       wubook_price (por room), toPay_breakdown, toPay (si no estaba),
 *       extrasUSD (si no estaba) usando extrasUSDPerRoomRaw (decidido en sync),
 *       y meta cruda: wubook_rooms_count / wubook_extrasUSD_total / perRoom.
 *
 * TIMEZONE
 *   - La noción de “hoy” la define WuBook; localmente mantenemos TZ AR para parsing/ISO.
 *
 * IDEMPOTENCIA
 *   - `contentHash` + preserva campos editados por host.
 *
 * SEGURIDAD / CONFIG
 *   - Requiere `getPropertiesAndRoomMaps()` con apiKey y roomMap.
 *   - ENV: `WUBOOK_BASE_URL` (opcional).
 *
 * ERRORES (4xx/5xx)
 *   - 400: no hay propiedades válidas / api_key
 *   - 405: método no permitido
 *   - 500: error interno
 *
 * EJEMPLO
 *   curl -X POST https://<app>/api/wubookSyncToday \
 *     -H "Content-Type: application/json" \
 *     -d '{ "propertyIds": ["106"], "dryRun": false }'
 */


import { getPropertiesAndRoomMaps } from '../lib/fetchPropertiesAndRoomMaps.js';
import { fetchToday, upsertReservations } from '../lib/importProcessShared.js';

const log = (...a) => console.log('[SyncToday]', ...a);

const ok = (res, data) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  return res.status(200).json(data);
};
const bad = (res, code, error) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  return res.status(code).json({ error });
};

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return ok(res, { ok: true });
  if (req.method !== 'POST' && req.method !== 'GET') return bad(res, 405, 'Método no permitido');

  try {
    const { propertyIds, dryRun = false } = (req.body && req.method === 'POST') ? req.body : {};

    const propiedades = await getPropertiesAndRoomMaps({ propertyIds, onlyActiveIfNoIds: true, log });
    if (!propiedades.length) return bad(res, 400, 'No se encontraron propiedades con api_key de WuBook.');

    const summary = [];
    for (const prop of propiedades) {
      log('PROP START', { id: prop.id, nombre: prop.nombre, roomsMapped: prop.roomMap.size });

      const reservas = await fetchToday({ apiKey: prop.apiKey });
      const result = await upsertReservations({
        reservas,
        prop,
        dryRun,
        sourceTag: 'wubookSyncToday',
        log
      });

      summary.push({
        propiedad: { id: prop.id, nombre: prop.nombre },
        found_today: reservas.length,
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