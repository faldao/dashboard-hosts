// src/services/hostsApi.js
import {
  collection, doc, getDoc, getDocs, setDoc, addDoc, updateDoc, deleteDoc,
  query, orderBy, limit as qLimit, serverTimestamp
} from "firebase/firestore";
import { db } from "../hosts/firebasehosts";

// Colecciones
const diasCol = collection(db, "dias");

export async function upsertDia(fecha) {
  // Crea (o asegura) el doc del día: /dias/{YYYY-MM-DD}
  const ref = doc(diasCol, fecha);
  await setDoc(ref, {
    fecha,
    last_updated: serverTimestamp()
  }, { merge: true });
  return fecha;
}

export async function listDias({ limit = 60 } = {}) {
  const q = query(diasCol, orderBy("fecha", "desc"), qLimit(limit));
  const snap = await getDocs(q);
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

export async function getDia(fecha) {
  // Devuelve encabezado + reservas (+ pagos por cada reserva)
  const ref = doc(diasCol, fecha);
  const head = await getDoc(ref);
  if (!head.exists()) return null;

  const reservasCol = collection(ref, "reservas");
  const rSnap = await getDocs(reservasCol);

  // Cargar pagos de cada reserva
  const reservas = [];
  for (const r of rSnap.docs) {
    const pagosSnap = await getDocs(collection(r.ref, "pagos"));
    reservas.push({
      id: r.id,
      ...r.data(),
      pagos: pagosSnap.docs.map(p => ({ id: p.id, ...p.data() }))
    });
  }
  return { fecha, ...head.data(), reservas };
}

export async function addReserva(fecha, enc, pagos = []) {
  const diaRef = doc(diasCol, fecha);
  const resRef = await addDoc(collection(diaRef, "reservas"), {
    enc, createdAt: serverTimestamp()
  });
  for (const p of pagos) {
    await addDoc(collection(resRef, "pagos"), {
      ...p, createdAt: serverTimestamp()
    });
  }
  await updateDoc(diaRef, { last_updated: serverTimestamp() });
  return resRef.id;
}

export async function updateReserva(fecha, reservaId, patch) {
  const ref = doc(db, `dias/${fecha}/reservas/${reservaId}`);
  await updateDoc(ref, patch);
  await updateDoc(doc(diasCol, fecha), { last_updated: serverTimestamp() });
}

export async function deleteReserva(fecha, reservaId) {
  await deleteDoc(doc(db, `dias/${fecha}/reservas/${reservaId}`));
  await updateDoc(doc(diasCol, fecha), { last_updated: serverTimestamp() });
}

export async function addPago(fecha, reservaId, pago) {
  const pagosCol = collection(db, `dias/${fecha}/reservas/${reservaId}/pagos`);
  await addDoc(pagosCol, { ...pago, createdAt: serverTimestamp() });
  await updateDoc(doc(diasCol, fecha), { last_updated: serverTimestamp() });
}
