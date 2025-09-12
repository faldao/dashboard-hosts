// dashboard/src/hosts/firebase.js
import { initializeApp } from "firebase/app";
import { getFirestore } from "firebase/firestore";
import { getAuth, signInAnonymously } from "firebase/auth";
import { getStorage } from "firebase/storage"; 

const firebaseConfig = {
  apiKey: "AIzaSyXXXXXXX...",
  authDomain: "gestion-reservas-viproomer.firebaseapp.com",
  projectId: "gestion-reservas-viproomer",
  storageBucket: "gestion-reservas-viproomer.appspot.com",
  messagingSenderId: "1234567890",
  appId: "1:1234567890:web:abc123def456",
  };

const app = initializeApp(firebaseConfig);
export const db = getFirestore(app);
export const storage = getStorage(app);

// Autenticación anónima
const auth = getAuth(app);
signInAnonymously(auth)
  .then(() => {
    console.log("🟢 Login anónimo exitoso");
  })
  .catch((error) => {
    console.error("❌ Error en login anónimo:", error.code, error.message);
  });