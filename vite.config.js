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
    // quitemos exceljs del prebundle de dev: no lo necesitás para la home
    include: ['file-saver', 'luxon'],
  },
  resolve: {
    alias: {
      // si alguna lib hace `require('process')` o `import process from 'process'`
      process: 'process/browser',
    },
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
    // evita que el código del cliente lea process real de Node
    'process.env': {},
    'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV || 'production'),
    'process.env.NODE_DEBUG': false,
  },
});


