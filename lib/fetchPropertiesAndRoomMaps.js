// lib/fetchPropertiesAndRoomMaps.js
// Utilidades para leer propiedades y armar roomMaps sin repetir código.

import { firestore } from './firebaseAdmin.js';

const defaultLog = (...xs) => console.log('[props]', ...xs);

/**
 * Devuelve un array de DocumentSnapshots de propiedades.
 * - Si vienen propertyIds => trae solo esas (y no filtra por booleano).
 * - Si NO vienen propertyIds => aplica filtro activar_para_planillas_diarias === true (por defecto).
 */
export async function fetchPropertyDocs({
  propertyIds,
  onlyActiveIfNoIds = true,
  log = defaultLog,
} = {}) {
  const col = firestore.collection('propiedades');

  if (Array.isArray(propertyIds) && propertyIds.length) {
    const snaps = await Promise.all(propertyIds.map((id) => col.doc(id).get()));
    const docs = snaps.filter((s) => s.exists);
    log('fetchPropertyDocs (by ids)', { requested: propertyIds.length, found: docs.length });
    return docs;
  }

  if (onlyActiveIfNoIds) {
    const snap = await col.where('activar_para_planillas_diarias', '==', true).get();
    log('fetchPropertyDocs (active only)', { count: snap.size });
    return snap.docs;
  }

  const snap = await col.get();
  log('fetchPropertyDocs (all)', { count: snap.size });
  return snap.docs;
}

/** Arma un Map(idZak => {codigo_depto, nombre_depto}) para una propiedad */
export async function buildRoomMapForProperty(propDoc, { log = defaultLog } = {}) {
  const depsSnap = await propDoc.ref.collection('departamentos').get();
  const roomMap = new Map();
  for (const dep of depsSnap.docs) {
    const v = dep.data();
    const idZak = dep.id;
    const codigo_depto = v?.codigo_depto || v?.wubook_shortname || dep.id;
    const nombre_depto = v?.nombre || v?.name || '';
    roomMap.set(idZak, { codigo_depto, nombre_depto });
  }
  log('buildRoomMap', { propId: propDoc.id, count: roomMap.size });
  return roomMap;
}

/**
 * Versión lista para los importadores:
 * Devuelve [{ id, nombre, apiKey, roomMap }]
 * - Respeta propertyIds si vienen
 * - Si no vienen, filtra por activar_para_planillas_diarias === true
 * - Excluye propiedades sin apiKey
 */
export async function getPropertiesAndRoomMaps({
  propertyIds,
  onlyActiveIfNoIds = true,
  log = defaultLog,
} = {}) {
  const propDocs = await fetchPropertyDocs({ propertyIds, onlyActiveIfNoIds, log });
  const results = [];

  // Cargar roomMaps en serie para no pasarnos de quotas. Si querés, se puede paralelizar.
  for (const d of propDocs) {
    const data = d.data() || {};
    if (onlyActiveIfNoIds && data?.activar_para_planillas_diarias !== true && !propertyIds?.length) {
      // doble check defensivo
      continue;
    }

    const apiKey =
      data?.api_key ||
      data?.integraciones?.wubook_apiKey ||
      data?.integraciones?.wubook?.apiKey;

    if (!apiKey) continue;

    const roomMap = await buildRoomMapForProperty(d, { log });

    results.push({
      id: d.id,
      nombre: data?.nombre || d.id,
      apiKey,
      roomMap,
    });
  }

  log('getPropertiesAndRoomMaps', { returned: results.length });
  return results;
}
