// vite.config.js
import { defineConfig, splitVendorChunkPlugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss(), splitVendorChunkPlugin()],
  root: '.',
  base: '/',
  server: { port: 5173 },

  // ✅ No prebundleo exceljs/file-saver; los cargo on-demand en el componente
  optimizeDeps: {
    exclude: ['exceljs', 'file-saver'],
    include: ['luxon'], // luxon sí conviene prebundlear
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
            if (id.includes('luxon')) return 'luxon';
            if (id.includes('/react/')) return 'react-vendor';
            return 'vendor';
          }
        },
      },
    },
  },

  define: {
    // varios paquetes asumen process/env en browser
    'process.env': {},
    'process.env.NODE_DEBUG': false,
  },
});





