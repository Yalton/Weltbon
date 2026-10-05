import { Hono } from 'hono';
import { env } from '../config.js';

export function buildRuntimeRoutes() {
  const routes = new Hono();
  routes.get('/', (c) => {
    const { localMode, inviteRequestsEnabled, landingRepoUrl } = env();
    return c.json({
      authMode: localMode ? 'local' as const : 'server' as const,
      landing: {
        // Local mode has no accounts to invite anyone into.
        inviteRequestsEnabled: inviteRequestsEnabled && !localMode,
        repoUrl: landingRepoUrl,
      },
    });
  });
  return routes;
}
