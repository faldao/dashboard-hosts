// src/components/ProtectedRoute.jsx

import React from 'react';
import { Navigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext'; // Ajusta la ruta si es necesario

// Este componente recibe "children", que es la página que queremos proteger.
export default function ProtectedRoute({ children }) {
  const { user, loading } = useAuth();

  // Si todavía estamos verificando si hay un usuario, mostramos un loader.
  // Esto es importante para evitar que se redirija al login brevemente al recargar la página.
  if (loading) {
    return (
      <div className="loader-container">
        <div className="loader">Verificando sesión...</div>
      </div>
    );
  }

  // Si ya no está cargando y NO hay usuario, lo redirigimos a la página de login.
  // El componente <Navigate> de react-router-dom se encarga de la redirección.
  if (!user) {
    return <Navigate to="/login" replace />;
  }

  // Si ya no está cargando y SÍ hay un usuario, simplemente mostramos la página "hija".
  return children;
}