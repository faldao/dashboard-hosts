// src/context/AuthContext.jsx
import React, { createContext, useContext, useEffect, useState } from 'react';
import { onAuthStateChanged, GoogleAuthProvider, signInWithPopup, signOut } from 'firebase/auth';
import { auth } from '../lib/firebase'; // Asegúrate que la ruta a tu config de firebase sea correcta

// 1. Creamos el contexto
const AuthContext = createContext();

// 2. Creamos el "Proveedor", el componente que contendrá toda la lógica
export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);

  // Este useEffect es el corazón: se ejecuta una sola vez cuando la app carga
  useEffect(() => {
    // onAuthStateChanged es un "oyente" de Firebase que se activa
    // cada vez que el estado de login cambia (alguien inicia sesión, cierra sesión, o se recarga la página)
    const unsubscribe = onAuthStateChanged(auth, (currentUser) => {
      setUser(currentUser); // Guarda el usuario actual (o null si no hay nadie)
      setLoading(false);    // Marca que ya terminamos de verificar
    });

    // Limpiamos el "oyente" cuando el componente se desmonta para evitar problemas de memoria
    return () => unsubscribe();
  }, []);

  // Función para iniciar sesión con el popup de Google
  const loginWithGoogle = () => {
    const provider = new GoogleAuthProvider();
    return signInWithPopup(auth, provider);
  };

  // Función para cerrar sesión
  const logout = () => {
    return signOut(auth);
  };

  // El valor que todos los componentes "hijos" podrán consumir
  const value = {
    user,
    loading,
    loginWithGoogle,
    logout
  };

  // Si no está cargando, renderiza los componentes hijos (tu app)
  // El `!loading && children` asegura que no se muestre nada hasta que sepamos si hay un usuario o no
  return (
    <AuthContext.Provider value={value}>
      {!loading && children}
    </AuthContext.Provider>
  );
}

// 3. Creamos un "Hook" personalizado para usar el contexto más fácilmente
// En lugar de importar `useContext` y `AuthContext` en cada archivo, solo importaremos `useAuth`
export function useAuth() {
  return useContext(AuthContext);
}