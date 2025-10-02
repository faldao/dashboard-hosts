// src/main.jsx
import './polyfills'; // <-- Debe ser la primera importación
import React from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom"; // <-- AGREGADO
import { AuthProvider } from "./context/AuthContext.jsx"; // <-- AGREGADO (ajustá la ruta si es necesario)
import App from "./App.jsx"; // <-- CAMBIADO: Ahora apunta a App.jsx
import "./index.css";

if (typeof window !== "undefined") {
  // si no existe window.process, lo creamos
  window.process = window.process || {};
  window.process.env = window.process.env || {};
  // muchas libs chequean NODE_ENV
  window.process.env.NODE_ENV = import.meta.env.MODE || "production";
}

// Monta la app en #root (definido en index.html)
const root = createRoot(document.getElementById("root"));

root.render(
  <React.StrictMode>
    {/* Envolvemos la App con los proveedores de Ruteo y Autenticación */}
    <BrowserRouter>
      <AuthProvider>
        <App />
      </AuthProvider>
    </BrowserRouter>
  </React.StrictMode>
);
