// src/main.jsx
import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App.jsx";

// CSS global de Tailwind y utilitarios de la app
import "./tw.css";


// Monta la app en #root (definido en index.html)
createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
