// vite.config.js
// vite.config.js
import { defineConfig, splitVendorChunkPlugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss(), splitVendorChunkPlugin()],
  root: '.',
  base: '/',
  server: { port: 5173 },
  optimizeDeps: {
    include: ['exceljs', 'file-saver', 'luxon'],
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2019',
    sourcemap: false,
    chunkSizeWarningLimit: 1500,
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
    // Reemplazos en tiempo de build
    global: 'globalThis',
    'process.env': {},                 // evita accesos simples a env
    'process.browser': 'true',         // algunas libs lo miran
  },
});



