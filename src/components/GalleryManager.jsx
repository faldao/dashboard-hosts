import React, { useRef, useState } from 'react';
import axios from 'axios';
import './GalleryManager.css';

function normalizeItems(items) {
  if (!Array.isArray(items)) return [];
  return items.map((item) => typeof item === 'string' ? { tag: '', url: item } : item).filter((item) => item?.url);
}

function loadImage(dataUrl) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('No se pudo leer la fotografía.'));
    image.src = dataUrl;
  });
}

function fileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('No se pudo leer el archivo.'));
    reader.readAsDataURL(file);
  });
}

async function preparePhoto(file) {
  const source = await fileAsDataUrl(file);
  const image = await loadImage(source);
  const maxSide = 1800;
  const scale = Math.min(1, maxSide / Math.max(image.naturalWidth, image.naturalHeight));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
  canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
  const context = canvas.getContext('2d');
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.86));
  if (!blob) throw new Error('No se pudo preparar la fotografía.');
  const output = await fileAsDataUrl(blob);
  return { contentType: 'image/jpeg', base64: String(output).split(',')[1] || '' };
}

export default function GalleryManager({ entity, propertyId, departmentId = '', items = [], onChange, disabled = false }) {
  const inputRef = useRef(null);
  const [selected, setSelected] = useState([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const gallery = normalizeItems(items);

  const clearSelected = () => {
    selected.forEach((item) => URL.revokeObjectURL(item.preview));
    setSelected([]);
    if (inputRef.current) inputRef.current.value = '';
  };

  const chooseFiles = (event) => {
    const files = Array.from(event.target.files || []).filter((file) => file.type.startsWith('image/')).slice(0, 12);
    clearSelected();
    setSelected(files.map((file) => ({ file, preview: URL.createObjectURL(file) })));
    setMessage(files.length ? `${files.length} fotografía${files.length === 1 ? '' : 's'} lista${files.length === 1 ? '' : 's'} para cargar.` : '');
  };

  const upload = async () => {
    if (!selected.length || disabled) return;
    setBusy(true);
    setMessage('Preparando fotografías…');
    try {
      let uploaded = 0;
      let currentGallery = gallery;
      for (const selectedItem of selected) {
        setMessage(`Cargando ${uploaded + 1} de ${selected.length}…`);
        const prepared = await preparePhoto(selectedItem.file);
        const { data } = await axios.post('/api/admin/property-images', {
          entity, propertyId, departmentId,
          fileName: selectedItem.file.name,
          ...prepared,
        });
        currentGallery = Array.isArray(data.gallery) ? data.gallery : [...currentGallery, data.item];
        onChange(currentGallery);
        uploaded += 1;
      }
      clearSelected();
      setMessage(`${uploaded} fotografía${uploaded === 1 ? '' : 's'} cargada${uploaded === 1 ? '' : 's'} correctamente.`);
    } catch (caught) {
      setMessage(caught?.response?.data?.error || caught.message || 'No se pudieron cargar las fotografías.');
    } finally {
      setBusy(false);
    }
  };

  const remove = async (item) => {
    if (!window.confirm('¿Eliminar esta fotografía de la galería?')) return;
    setBusy(true);
    setMessage('Eliminando fotografía…');
    try {
      const { data } = await axios.delete('/api/admin/property-images', {
        data: { entity, propertyId, departmentId, url: item.url, storagePath: item.storagePath || '' },
      });
      onChange(Array.isArray(data.gallery) ? data.gallery : gallery.filter((candidate) => candidate.url !== item.url));
      setMessage('Fotografía eliminada.');
    } catch (caught) {
      setMessage(caught?.response?.data?.error || 'No se pudo eliminar la fotografía.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="gallery-manager">
      <div className="gallery-manager__head">
        <div><strong>Fotografías</strong><span>{gallery.length} en la galería</span></div>
        <div className="gallery-manager__actions">
          <input ref={inputRef} type="file" accept="image/jpeg,image/png,image/webp" multiple onChange={chooseFiles} disabled={disabled || busy} />
          <button type="button" onClick={() => inputRef.current?.click()} disabled={disabled || busy}>Buscar fotos</button>
          <button type="button" className="gallery-manager__upload" onClick={upload} disabled={disabled || busy || !selected.length}>Cargar seleccionadas</button>
        </div>
      </div>

      {disabled ? <p className="gallery-manager__message">Guardá el registro antes de cargar fotografías.</p> : null}
      {message ? <p className="gallery-manager__message">{message}</p> : null}

      {selected.length ? (
        <div className="gallery-manager__selection">
          {selected.map((item) => <img key={item.preview} src={item.preview} alt={`Vista previa de ${item.file.name}`} />)}
        </div>
      ) : null}

      <div className="gallery-manager__grid">
        {gallery.map((item, index) => (
          <article key={`${item.url}-${index}`}>
            <img src={item.url} alt={item.tag || `Fotografía ${index + 1}`} loading="lazy" />
            <div><span title={item.tag || ''}>{item.tag || `Fotografía ${index + 1}`}</span><button type="button" onClick={() => remove(item)} disabled={busy}>Eliminar</button></div>
          </article>
        ))}
        {!gallery.length ? <p>La galería todavía no tiene fotografías.</p> : null}
      </div>
    </section>
  );
}
