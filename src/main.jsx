// src/main.jsx
import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import HostsLayout from './hosts/HostsLayout';
import PlanillasList from './hosts/PlanillasList';
import PlanillaEditor from './hosts/PlanillaEditor';
import './App.css';

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <BrowserRouter>
  {/* Sección anfitriones */}
  <Route path="/hosts" element={<HostsLayout />}>
    <Route index element={<PlanillasList />} />           {/* /hosts */}
    <Route path="new" element={<PlanillaEditor mode="new" />} />   {/* /hosts/new */}
    <Route path=":fecha" element={<PlanillaEditor />} />           {/* /hosts/2025-08-16 */}
  </Route>
    </BrowserRouter>
  </React.StrictMode>
);  