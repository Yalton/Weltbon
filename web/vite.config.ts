import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: {
      // The API mounts every route under `/api` (api/src/index.ts:
      // `app.route('/api', apiR)` + `app.route('/api/share', shareRoutes)`), and
      // web/src/api/client.ts already fetches `/api${path}`. So the prefix must be
      // forwarded VERBATIM — no rewrite. Stripping it made the API fall through to
      // its SPA catch-all (`app.get('*', serveStatic('./web-dist/index.html'))`),
      // which answered every dev-mode API call with 200 text/html and blew up the
      // client's JSON.parse on `<!doctype`.
      '/api': {
        target: 'http://127.0.0.1:3000',
        changeOrigin: false,
      },
    },
  },
});
