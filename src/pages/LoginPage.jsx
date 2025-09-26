// src/pages/LoginPage.jsx
import React, { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext'; // Ajusta la ruta si es necesario
import AuthButtons from '../components/AuthButtons'; // Ajusta la ruta si es necesario

export default function LoginPage() {
  const { user, loading } = useAuth();
  const navigate = useNavigate();

  // Este efecto se encarga de redirigir al usuario si ya está logueado
  useEffect(() => {
    if (!loading && user) {
      // Si ya no está cargando y hay un usuario, lo enviamos al portal.
      // El 'replace: true' evita que pueda volver a la página de login con el botón "Atrás" del navegador.
      navigate('/dashboard', { replace: true });
    }
  }, [user, loading, navigate]);

  // Mientras se verifica el estado de autenticación, o si el usuario ya existe (y está por ser redirigido),
  // mostramos un loader para evitar que la pantalla de login "parpadee".
  if (loading || user) {
    return (
      <div className="loader-container">
        <div className="loader">Cargando...</div>
      </div>
    );
  }
  
  // Si no está cargando y no hay usuario, mostramos la interfaz de login.
  return (
    <div className="login-container">
      <div className="login-box">
        {/* Podrías poner tu logo aquí */}
        {/* <img src="/path/to/your/logo.svg" alt="Logo" className="login-logo" /> */}
        
        <h1 className="login-title">Portal de Hosts</h1>
        <p className="login-subtitle">Iniciá sesión para gestionar tus aplicaciones</p>
        
        <div className="login-button-wrapper">
          <AuthButtons />
        </div>
      </div>
    </div>
  );
}