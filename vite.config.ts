import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  root: 'src/ui',
  plugins: [react()],
  build: {
    outDir: '../../dist/ui',
    emptyOutDir: true,
  },
  server: {
    port: 5317,
    proxy: {
      '/api': 'http://127.0.0.1:4317',
      '/mcp': 'http://127.0.0.1:4317',
      '/health': 'http://127.0.0.1:4317',
    },
  },
});
