import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { listDias, upsertDia } from '../services/HostsApi';

export default function PlanillasList() {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [limit, setLimit] = useState(30);
  const navigate = useNavigate();

  useEffect(() => { fetchList(); }, [limit]);

  async function fetchList() {
    setLoading(true);
    try {
      const rows = await listDias({ limit });
      setItems(rows || []);
    } catch (e) {
      console.error('Error listDias:', e);
      setItems([]);
    } finally {
      setLoading(false);
    }
  }

  async function crearHoy() {
    const hoy = new Date().toISOString().slice(0,10);
    try {
      await upsertDia(hoy);
      navigate(`/hosts/${hoy}`);
    } catch (e) {
      console.error('Error upsertDia:', e);
      alert('No se pudo crear la planilla.');
    }
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <h1 className="text-xl font-bold">Planillas diarias</h1>
        <div className="flex gap-2">
          <button onClick={crearHoy} className="bg-blue-600 text-white px-3 py-1 rounded">
            Crear planilla de hoy
          </button>
          <Link to="/hosts/new" className="border px-3 py-1 rounded">Elegir otra fecha</Link>
        </div>
      </div>

      {loading ? <p>Cargando…</p> : (
        <div className="overflow-x-auto border rounded">
          <table className="min-w-full text-sm">
            <thead className="bg-gray-50">
              <tr>
                <th className="p-2">Fecha</th>
                <th className="p-2 text-right">Reservas</th>
                <th className="p-2 text-right">Pagos ARS</th>
                <th className="p-2 text-right">Pagos USD</th>
                <th className="p-2"></th>
              </tr>
            </thead>
            <tbody>
              {items.map(d => (
                <tr key={d.fecha} className="border-b hover:bg-gray-50">
                  <td className="p-2">{d.fecha}</td>
                  <td className="p-2 text-right">{d.total_reservas ?? '-'}</td>
                  <td className="p-2 text-right">{fmt(d.total_pagos_ARS)}</td>
                  <td className="p-2 text-right">{fmt(d.total_pagos_USD)}</td>
                  <td className="p-2 text-right">
                    <Link className="border px-2 py-1 rounded" to={`/hosts/${d.fecha}`}>Abrir</Link>
                  </td>
                </tr>
              ))}
              {!items.length && (
                <tr><td className="p-2 text-gray-500" colSpan={5}>No hay planillas aún.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

const fmt = (n) => (typeof n === 'number' ? n.toLocaleString('es-AR') : '—');
