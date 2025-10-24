// src/App.jsx
import { Routes, Route, Navigate } from 'react-router-dom';

// 1. Importa los componentes de tus páginas
import LoginPage from './pages/LoginPage';
import DashboardPage from './pages/DashboardPage';
import PlanillaHostsPage from './pages/PlanillaHostsPage';
import LiquidacionesPage from './pages/LiquidacionesPage';

// 2. Importa tu componente de ruta protegida
import ProtectedRoute from './components/ProtectedRoute';

// Opcional: Si tienes estilos globales para la App, impórtalos aquí
import './App.css'; 

function App() {
  return (
    // El componente <Routes> revisa la URL actual y renderiza la primera <Route> que coincida
    <Routes>
      
      {/* RUTA PÚBLICA: Cualquiera puede acceder a /login */}
      <Route path="/login" element={<LoginPage />} />

      {/* --- RUTAS PROTEGIDAS --- */}
      {/* Usamos el componente <ProtectedRoute> como envoltorio.
          Si el usuario no está logueado, lo redirigirá a /login.
          Si está logueado, mostrará la página correspondiente. */}
      
      <Route 
        path="/dashboard" 
        element={
          <ProtectedRoute>
            <DashboardPage />
          </ProtectedRoute>
        } 
      />
      
      <Route 
        path="/planilla-hosts" 
        element={
          <ProtectedRoute>
            <PlanillaHostsPage />
          </ProtectedRoute>
        } 
      />
      <Route
  path="/liquidaciones"
  element={
    <ProtectedRoute>
      <LiquidacionesPage />
    </ProtectedRoute>
  }
/>

      {/* RUTA POR DEFECTO / REDIRECCIÓN */}
      {/* Si un usuario entra a la raíz del sitio ('/'), lo mandamos directo al dashboard. */}
      <Route path="/" element={<Navigate to="/dashboard" replace />} />
      
      {/* Opcional: Una ruta "catch-all" para manejar URLs no encontradas (404) */}
      <Route path="*" element={
          <div>
            <h1>404: Página No Encontrada</h1>
            <a href="/dashboard">Volver al inicio</a>
          </div>
        } 
      />
    </Routes>
  );
}

export default App;