import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { getDia, upsertDia, addReserva } from '../services/HostsApi';

export default function PlanillaEditor({ mode }) {
  const { fecha: fechaParam } = useParams();
  const navigate = useNavigate();
  const [fecha, setFecha] = useState(fechaParam || new Date().toISOString().slice(0,10));
  const [loading, setLoading] = useState(!!fechaParam);
  const [dia, setDia] = useState(null);
  const [savingDemo, setSavingDemo] = useState(false);

  useEffect(() => {
    if (!fechaParam) return;
    (async () => {
      try {
        const d = await getDia(fechaParam);
        setDia(d || { fecha: fechaParam, reservas: [] });
      } catch (e) {
        console.error('Error getDia:', e);
      } finally {
        setLoading(false);
      }
    })();
  }, [fechaParam]);

  async function crearYEntrar() {
    try {
      await upsertDia(fecha);
      navigate(`/hosts/${fecha}`);
    } catch (e) {
      console.error('Error upsertDia:', e);
      alert('No se pudo crear la planilla.');
    }
  }

  async function demoAgregarReserva() {
    if (!fechaParam) {
      alert('No hay fecha seleccionada.');
      return;
    }
    setSavingDemo(true);
    try {
      await addReserva(
        fechaParam,
        {
          codigo_reserva: 'ABC123',
          codigo_depto: 'LOD1',
          nombre_huesped: 'Juan',
          telefono: '+54...',
          canal: 'Booking',
          cant_huespedes: 2,
          hora_checkin: '18:00',
          hora_checkout: '10:00',
          hosts: ['manu'],
          notas: ''
        },
        [
          { monto: 150000, moneda: 'ARS', forma: 'Efectivo', fecha: fechaParam }
        ]
      );
      const d = await getDia(fechaParam);
      setDia(d || { fecha: fechaParam, reservas: [] });
    } catch (e) {
      console.error('Error addReserva:', e);
      alert('No se pudo agregar la reserva demo.');
    } finally {
      setSavingDemo(false);
    }
  }

  if (mode === 'new') {
    return (
      <div>
        <h1 className="text-xl font-bold mb-3">Nueva planilla</h1>
        <div className="flex items-center gap-2">
          <input
            type="date"
            value={fecha}
            onChange={e => setFecha(e.target.value)}
            className="border p-2 rounded"
          />
          <button
            onClick={crearYEntrar}
            className="bg-blue-600 text-white px-3 py-1 rounded"
          >
            Crear
          </button>
        </div>
      </div>
    );
  }

  if (loading) return <p>Cargando…</p>;

  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <h1 className="text-xl font-bold">Planilla — {fechaParam}</h1>
        <button
          onClick={demoAgregarReserva}
          disabled={savingDemo}
          className={`px-3 py-1 rounded text-white ${
            savingDemo ? 'bg-gray-500' : 'bg-emerald-600 hover:bg-emerald-700'
          }`}
          title="Inserta una reserva y un pago de ejemplo en este día"
        >
          {savingDemo ? 'Agregando…' : 'Agregar reserva demo'}
        </button>
      </div>

      {/* fallback si aún no hay datos */}
      {!dia ? (
        <p className="text-gray-600">No hay datos del día todavía.</p>
      ) : (
        <pre className="bg-gray-900 text-white p-3 text-xs rounded overflow-auto">
          {JSON.stringify(dia, null, 2)}
        </pre>
      )}

      <p className="text-gray-500 mt-2">
        (Próximo paso: insertar la tabla editable con reservas/pagos)
      </p>
    </div>
  );
}

