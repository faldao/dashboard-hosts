// vite.config.js
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  root: '.',
  base: './', // <- Esto asegura que los assets se carguen correctamente desde rutas relativas
  server: {
    port: 5173
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true
  }
});
