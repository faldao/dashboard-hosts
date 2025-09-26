// src/components/AuthButtons.jsx

import React from 'react';
import { useAuth } from '../context/AuthContext'; // Ajusta la ruta si es necesario

export default function AuthButtons() {
  // Obtenemos todo lo que necesitamos de nuestro contexto de autenticación
  const { user, loading, loginWithGoogle, logout } = useAuth();

  // No mostramos nada mientras se verifica el estado inicial para evitar un "parpadeo" de los botones
  if (loading) {
    return null;
  }

  return (
    <div className="auth-buttons-container">
      {user ? (
        // Si hay un usuario, mostramos el estado "logueado"
        <>
          <span className="user-greeting">Hola, {user.displayName}!</span>
          <button onClick={logout} className="btn btn--logout">
            Cerrar Sesión
          </button>
        </>
      ) : (
        // Si no hay usuario, mostramos el estado "deslogueado"
        <button onClick={loginWithGoogle} className="btn btn--login-google">
          {/* Opcional: Podés agregar un ícono de Google aquí */}
          Iniciar Sesión con Google
        </button>
      )}
    </div>
  );
}