import type { Hono } from 'hono';
import { serveStatic } from '@hono/node-server/serve-static';

const ASSET_CACHE = 'public, max-age=31536000, immutable';
const INDEX_CACHE = 'no-cache';
const OTHER_CACHE = 'public, max-age=3600';

/**
 * Serve the built web app from `webDist`. Register after the API routes: it
 * answers every path they did not, falling back to index.html for SPA routes.
 *
 * Vite names everything under /assets by content hash, so those files can be
 * cached for good. index.html points at the current hashes and must be
 * revalidated, or a deploy would leave browsers on the old bundle. The web
 * build writes .br and .gz copies beside each text file; `precompressed`
 * serves them to clients that accept them.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function registerWebStatic(app: Hono<any>, webDist: string) {
  // serveStatic's onFound hook runs after the response is built, too late to
  // add headers, so set Cache-Control on the way out instead.
  app.use('*', async (c, next) => {
    await next();
    if (c.req.path.startsWith('/api/') || c.res.status !== 200) return;
    const cache = c.res.headers.get('content-type')?.startsWith('text/html')
      ? INDEX_CACHE
      : c.req.path.startsWith('/assets/') ? ASSET_CACHE : OTHER_CACHE;
    c.res.headers.set('Cache-Control', cache);
  });

  const index = serveStatic({ path: `${webDist}/index.html`, precompressed: true });
  app.use('*', serveStatic({ root: webDist, precompressed: true }));
  app.get('/', index);
  app.get('*', index);
}
