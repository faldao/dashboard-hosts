// vite.config.js
import { defineConfig, splitVendorChunkPlugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss(), splitVendorChunkPlugin()],
  root: '.',
  base: './',                 // rutas relativas (si tu hosting lo necesita)
  server: { port: 5173 },
  optimizeDeps: {
    include: ['exceljs', 'file-saver', 'luxon'], // prebundle para dev
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2019',
    sourcemap: false,
    chunkSizeWarningLimit: 1500,   // subimos umbral del warning
    treeshake: true,
    commonjsOptions: { transformMixedEsModules: true },
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules')) {
            if (id.includes('exceljs')) return 'excel';
            if (id.includes('file-saver')) return 'filesaver';
            if (id.includes('luxon')) return 'luxon';
            if (id.includes('/react/')) return 'react-vendor';
            return 'vendor';
          }
        },
      },
    },
  },
  define: {
    // algunos paquetes asumen process/env en browser; lo “stub-eamos”
    'process.env': {},
    'process.env.NODE_DEBUG': false,
  },
});

