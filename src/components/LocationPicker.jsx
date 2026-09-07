import React, { useEffect, useRef, useState } from 'react';
import axios from 'axios';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import './LocationPicker.css';

const DEFAULT_CENTER = [-41.1335, -71.3103];

function validCoordinates(value) {
  const lat = Number(value?.lat);
  const lng = Number(value?.lng);
  return Number.isFinite(lat) && Number.isFinite(lng) && lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180;
}

export default function LocationPicker({ value, onChange }) {
  const mapElementRef = useRef(null);
  const mapRef = useRef(null);
  const markerRef = useRef(null);
  const valueRef = useRef(value);
  const [query, setQuery] = useState(value?.direccion || '');
  const [results, setResults] = useState([]);
  const [searching, setSearching] = useState(false);
  const [message, setMessage] = useState('');

  valueRef.current = value;

  const setCoordinates = (lat, lng, extra = {}) => {
    onChange({
      ...valueRef.current,
      ...extra,
      lat: Number(Number(lat).toFixed(7)),
      lng: Number(Number(lng).toFixed(7)),
    });
  };

  useEffect(() => {
    if (!mapElementRef.current || mapRef.current) return;
    const initial = validCoordinates(valueRef.current)
      ? [Number(valueRef.current.lat), Number(valueRef.current.lng)]
      : DEFAULT_CENTER;
    const map = L.map(mapElementRef.current, { scrollWheelZoom: true }).setView(initial, validCoordinates(valueRef.current) ? 16 : 12);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    }).addTo(map);
    map.on('click', (event) => setCoordinates(event.latlng.lat, event.latlng.lng));
    mapRef.current = map;
    window.setTimeout(() => map.invalidateSize(), 0);
    return () => {
      map.remove();
      mapRef.current = null;
      markerRef.current = null;
    };
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (!validCoordinates(value)) {
      if (markerRef.current) markerRef.current.remove();
      markerRef.current = null;
      return;
    }
    const position = [Number(value.lat), Number(value.lng)];
    if (!markerRef.current) {
      markerRef.current = L.marker(position, {
        draggable: true,
        icon: L.divIcon({ className: 'location-picker-pin', html: '<span></span>', iconSize: [28, 38], iconAnchor: [14, 36] }),
      }).addTo(map);
      markerRef.current.on('dragend', () => {
        const next = markerRef.current.getLatLng();
        setCoordinates(next.lat, next.lng);
      });
      map.setView(position, 17);
    } else {
      markerRef.current.setLatLng(position);
      map.panTo(position);
    }
  }, [value?.lat, value?.lng]);

  useEffect(() => {
    setQuery(value?.direccion || '');
  }, [value?.direccion]);

  const updateField = (event) => {
    const { name, value: next } = event.target;
    onChange({ ...value, [name]: next });
  };

  const search = async () => {
    setSearching(true);
    setMessage('');
    try {
      const { data } = await axios.get('/api/admin/geocode', { params: { q: query } });
      setResults(data.results || []);
      if (!data.results?.length) setMessage('No se encontraron resultados. Probá agregando ciudad y provincia.');
    } catch (caught) {
      setMessage(caught?.response?.data?.error || 'No se pudo buscar la dirección.');
    } finally {
      setSearching(false);
    }
  };

  const chooseResult = (result) => {
    setCoordinates(result.lat, result.lng, { direccion: result.label, zona: result.zona || value?.zona || '' });
    mapRef.current?.setView([result.lat, result.lng], 17);
    setQuery(result.label);
    setResults([]);
    setMessage('Ubicación seleccionada. Ajustá el marcador si fuera necesario.');
  };

  const useCurrentPosition = () => {
    if (!navigator.geolocation) {
      setMessage('Este navegador no permite obtener la ubicación.');
      return;
    }
    setMessage('Obteniendo ubicación actual…');
    navigator.geolocation.getCurrentPosition(
      (position) => {
        setCoordinates(position.coords.latitude, position.coords.longitude);
        mapRef.current?.setView([position.coords.latitude, position.coords.longitude], 17);
        setMessage('Ubicación actual seleccionada.');
      },
      () => setMessage('No se pudo obtener la ubicación actual.'),
      { enableHighAccuracy: true, timeout: 12000 }
    );
  };

  return (
    <section className="location-picker">
      <div className="location-picker__title">
        <div><strong>Localización geográfica</strong><span>Buscá una dirección o marcá el punto exacto en el mapa.</span></div>
        <button type="button" onClick={useCurrentPosition}>Usar mi ubicación</button>
      </div>
      <div className="location-picker__search">
        <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Ej. Güemes 671, Bariloche" aria-label="Dirección para buscar" />
        <button type="button" onClick={search} disabled={searching}>{searching ? 'Buscando…' : 'Buscar en el mapa'}</button>
      </div>
      {results.length ? <div className="location-picker__results">{results.map((result) => <button key={`${result.lat}-${result.lng}`} type="button" onClick={() => chooseResult(result)}>{result.label}</button>)}</div> : null}
      {message ? <p className="location-picker__message">{message}</p> : null}
      <div className="location-picker__map" ref={mapElementRef} />
      <div className="location-picker__fields">
        <label><span>Dirección</span><input name="direccion" value={value?.direccion || ''} onChange={updateField} /></label>
        <label><span>Zona</span><input name="zona" value={value?.zona || ''} onChange={updateField} /></label>
        <label><span>Latitud</span><input name="lat" type="number" step="any" min="-90" max="90" value={value?.lat ?? ''} onChange={updateField} /></label>
        <label><span>Longitud</span><input name="lng" type="number" step="any" min="-180" max="180" value={value?.lng ?? ''} onChange={updateField} /></label>
      </div>
      <p className="location-picker__help">Podés hacer clic sobre el mapa o arrastrar el marcador para definir el punto exacto de la propiedad.</p>
    </section>
  );
}
