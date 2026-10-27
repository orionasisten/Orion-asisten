import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// Development: Vite mem-proxy /v1 ke Orion Central lokal → SAME-ORIGIN,
// sehingga cookie sesi (SameSite=Strict) bekerja tanpa CORS.
// Production (Cloudflare Pages): set VITE_API_URL=https://orion-central.up.railway.app
//   → lintas origin; server memakai CORS allowlist + cookie SameSite=None; Secure.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/v1': {
        target: process.env.ORION_API_URL || 'http://127.0.0.1:8787',
        changeOrigin: false,
        // SSE butuh proxy tanpa buffering
        configure: (proxy) => {
          proxy.on('proxyRes', (proxyRes) => {
            if ((proxyRes.headers['content-type'] || '').includes('text/event-stream')) {
              proxyRes.headers['x-accel-buffering'] = 'no';
            }
          });
        }
      }
    }
  },
  build: {
    outDir: 'dist',
    sourcemap: false,   // jangan|source map| berisi secret ke publik
    target: 'es2020'
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./tests/setup.ts'],
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx']
  }
});
