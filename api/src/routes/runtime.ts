import { Hono } from 'hono';
import { env } from '../config.js';

export function buildRuntimeRoutes() {
  const routes = new Hono();
  routes.get('/', (c) => c.json({
    authMode: env().localMode ? 'local' as const : 'server' as const,
  }));
  return routes;
}
