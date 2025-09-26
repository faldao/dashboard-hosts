// lib/firebase.js

import { initializeApp } from "firebase/app";
import { getAuth } from "firebase/auth";
import { getFirestore } from "firebase/firestore";

// 1. Leemos la variable de entorno que contiene el string JSON
const firebaseConfigString = import.meta.env.VITE_FIREBASE_CONFIG_JSON;

// 2. Verificamos que la variable exista para evitar errores
if (!firebaseConfigString) {
  throw new Error("La variable de entorno VITE_FIREBASE_CONFIG_JSON no está definida. Revisa tu archivo .env");
}

// 3. Convertimos (parseamos) el string JSON a un objeto JavaScript
const firebaseConfig = JSON.parse(firebaseConfigString);

// Inicializamos la aplicación de Firebase con el objeto ya parseado
const app = initializeApp(firebaseConfig);

// Exportamos los servicios que vamos a usar en nuestra aplicación
export const auth = getAuth(app);
export const firestore = getFirestore(app);