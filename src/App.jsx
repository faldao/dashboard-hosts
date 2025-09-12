// dashboard/src/App.jsx
import { useEffect, useState } from "react";
import { collection, getDocs, updateDoc, doc } from "firebase/firestore";
import { db } from "./firebase";
import './App.css';

export default function App() {
  const [propiedades, setPropiedades] = useState([]);
  const [busqueda, setBusqueda] = useState("");

  useEffect(() => {
    async function fetchData() {
      const querySnapshot = await getDocs(collection(db, "propiedades"));
      const data = querySnapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
      setPropiedades(data);
    }
    fetchData();
  }, []);

  const handleChange = (id, field, value) => {
    setPropiedades((prev) =>
      prev.map((p) => (p.id === id ? { ...p, [field]: value } : p))
    );
  };

  const guardarCambios = async (id) => {
    const propiedad = propiedades.find((p) => p.id === id);
    const docRef = doc(db, "propiedades", id);
    await updateDoc(docRef, {
      descripcion: propiedad.descripcion,
      descripcion_detallada: propiedad.descripcion_detallada,
      tipo_viajero: propiedad.tipo_viajero,
      historia: propiedad.historia
    });
    alert("Cambios guardados para " + propiedad.nombre);
  };

  const propiedadesFiltradas = propiedades.filter((p) =>
    p.nombre.toLowerCase().includes(busqueda.toLowerCase())
  );

  return (
    <div className="container">
      <h1>Dashboard de Propiedades</h1>
      <input
        placeholder="Buscar propiedad..."
        value={busqueda}
        onChange={(e) => setBusqueda(e.target.value)}
        className="buscador"
      />
      {propiedadesFiltradas.map((p) => (
        <div key={p.id} className="card">
          <h2>{p.nombre}</h2>
          <label>Descripción corta</label>
          <textarea
            value={p.descripcion}
            onChange={(e) => handleChange(p.id, "descripcion", e.target.value)}
            placeholder="Descripción corta"
          />
          <label>Descripción detallada</label>
          <textarea
            value={p.descripcion_detallada}
            onChange={(e) => handleChange(p.id, "descripcion_detallada", e.target.value)}
            placeholder="Descripción detallada"
          />
          <label>Tipo de viajero</label>
          <input
            value={p.tipo_viajero || ""}
            onChange={(e) => handleChange(p.id, "tipo_viajero", e.target.value)}
            placeholder="Tipo de viajero"
          />
          <label>Historia</label>
          <textarea
            value={p.historia || ""}
            onChange={(e) => handleChange(p.id, "historia", e.target.value)}
            placeholder="Historia"
          />
          <button onClick={() => guardarCambios(p.id)}>Guardar</button>
        </div>
      ))}
    </div>
  );
}
