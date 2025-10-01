// src/context/AuthContext.jsx
import React, { createContext, useContext, useEffect, useMemo, useState } from 'react';
import axios from 'axios';
import {
  onAuthStateChanged,
  onIdTokenChanged,
  GoogleAuthProvider,
  signInWithPopup,
  signOut,
} from 'firebase/auth';
import { auth } from '../../lib/firebase'; // tu init de Firebase

const AuthContext = createContext();

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [idToken, setIdToken] = useState(null);
  const [loading, setLoading] = useState(true);

  // 1) Estado de sesión (login/logout)
  useEffect(() => {
    const unSub = onAuthStateChanged(auth, async (currentUser) => {
      setUser(currentUser);
      setLoading(false);
    });
    return () => unSub();
  }, []);

  // 2) Refrescos del token (cada ~1h o cuando cambia el usuario)
  useEffect(() => {
    const unTok = onIdTokenChanged(auth, async (currentUser) => {
      if (!currentUser) {
        setIdToken(null);
        return;
      }
      const t = await currentUser.getIdToken(/* forceRefresh? false */);
      setIdToken(t);
    });
    return () => unTok();
  }, []);

  // 3) Interceptor de Axios para enviar Authorization: Bearer <token>
  useEffect(() => {
    // instalamos/eliminamos interceptor cada vez que cambia el token
    const id = axios.interceptors.request.use(async (config) => {
      if (idToken) {
        config.headers = config.headers || {};
        config.headers.Authorization = `Bearer ${idToken}`;
      } else {
        // limpiamos si no hay token
        if (config?.headers?.Authorization) delete config.headers.Authorization;
      }
      return config;
    });
    return () => axios.interceptors.request.eject(id);
  }, [idToken]);

  const loginWithGoogle = () => {
    const provider = new GoogleAuthProvider();
    return signInWithPopup(auth, provider);
  };

  const logout = () => signOut(auth);

  // 4) Valor del contexto
  const value = useMemo(() => ({
    user,          // objeto FirebaseUser o null
    idToken,       // string o null (ya se inyecta en axios automáticamente)
    loading,
    loginWithGoogle,
    logout,
  }), [user, idToken, loading]);
return (
    <AuthContext.Provider value={value}>
      {!loading && children}
    </AuthContext.Provider>
  );
}
export function useAuth() {
  return useContext(AuthContext);
}
