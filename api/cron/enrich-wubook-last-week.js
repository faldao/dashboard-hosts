import { DateTime } from 'luxon';

const TZ = 'America/Argentina/Buenos_Aires';
const BASE =
  process.env.PUBLIC_BASE_URL ||
  (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : null);

async function postJSON(path, body) {
  const response = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (!response.ok) throw new Error(`${path}: ${response.status} ${JSON.stringify(data).slice(0, 500)}`);
  return data;
}

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Method Not Allowed' });
  }
  if (!BASE) return res.status(500).json({ ok: false, error: 'No PUBLIC_BASE_URL/VERCEL_URL available' });

  try {
    const today = DateTime.now().setZone(TZ).startOf('day');
    const from = today.minus({ days: 6 });
    const range = { from: from.toISODate(), to: today.toISODate(), timezone: TZ };

    // Reimportar primero conserva el booker ID y los datos crudos necesarios
    // para que el enriquecimiento pueda reintentar nombres faltantes.
    const imported = await postJSON('/api/wubookImportByArrival', {
      fromDate: from.toFormat('dd/LL/yyyy'),
      toDate: today.toFormat('dd/LL/yyyy'),
      dryRun: false,
    });
    const enriched = await postJSON('/api/enrichWubookData', {
      limit: 500,
      dryRun: false,
      forceUpdate: true,
      dateFrom: range.from,
      dateTo: range.to,
      dateField: 'arrival_iso',
    });

    return res.status(200).json({ ok: true, range, imported, enriched });
  } catch (error) {
    console.error('[EnrichWubookLastWeek]', error);
    return res.status(500).json({ ok: false, error: error?.message || 'Unexpected error' });
  }
}
