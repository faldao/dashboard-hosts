import { authAdmin, firestore } from '../../lib/firebaseAdmin.js';

function send(res, status, body) {
  res.setHeader('Cache-Control', 'private, max-age=300');
  return res.status(status).json(body);
}

async function requireDashboardUser(req) {
  const header = req.headers?.authorization || req.headers?.Authorization || '';
  const token = String(header).match(/^Bearer\s+(.+)$/i)?.[1];
  if (!token) return null;
  try {
    const decoded = await authAdmin.verifyIdToken(token);
    const profile = await firestore.collection('users').doc(decoded.uid).get();
    return profile.exists ? decoded : null;
  } catch {
    return null;
  }
}

export default async function handler(req, res) {
  if (req.method !== 'GET') return send(res, 405, { error: 'Método no permitido' });
  if (!(await requireDashboardUser(req))) return send(res, 401, { error: 'Sesión inválida o vencida' });
  const query = String(req.query?.q || '').trim().slice(0, 300);
  if (query.length < 3) return send(res, 400, { error: 'Ingresá una dirección para buscar' });

  try {
    const url = new URL('https://nominatim.openstreetmap.org/search');
    url.searchParams.set('q', query);
    url.searchParams.set('format', 'jsonv2');
    url.searchParams.set('limit', '5');
    url.searchParams.set('addressdetails', '1');
    const response = await fetch(url, {
      headers: {
        Accept: 'application/json',
        'Accept-Language': 'es',
        'User-Agent': 'DashboardHosts/1.0 (https://dashboard-hosts.vercel.app)',
      },
    });
    if (!response.ok) throw new Error(`Servicio de mapas: ${response.status}`);
    const data = await response.json();
    const results = (Array.isArray(data) ? data : []).map((item) => ({
      label: item.display_name,
      lat: Number(item.lat),
      lng: Number(item.lon),
      zona: item.address?.suburb || item.address?.neighbourhood || item.address?.city || item.address?.town || '',
    })).filter((item) => Number.isFinite(item.lat) && Number.isFinite(item.lng));
    return send(res, 200, { ok: true, results });
  } catch (error) {
    console.error('[admin/geocode]', error);
    return send(res, 502, { error: 'No se pudo consultar el servicio de mapas' });
  }
}
