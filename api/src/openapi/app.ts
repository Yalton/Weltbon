/**
 * OpenAPIHono application instance for the Weltbon API.
 *
 * This module exports a pre-configured OpenAPIHono instance used as the `apiR`
 * sub-router inside createApp(). It registers the security schemes (D-04/D-05)
 * and exposes getOpenAPIDocument() for the /api/openapi.json endpoint.
 */

import { OpenAPIHono } from '@hono/zod-openapi';
import type { AuthVariables } from '../middleware/auth.js';
import { bearerAuthScheme, bearerJwtAuthScheme } from './security.js';

export type AppEnv = { Variables: AuthVariables };

/**
 * Create a fresh OpenAPIHono instance with security schemes registered.
 *
 * Called once in createApp() to build the API sub-router.
 */
export function createApiRouter(): OpenAPIHono<AppEnv> {
  const app = new OpenAPIHono<AppEnv>();

  // Register security schemes — D-04/D-05
  app.openAPIRegistry.registerComponent('securitySchemes', 'bearerAuth', bearerAuthScheme);
  app.openAPIRegistry.registerComponent('securitySchemes', 'bearerJwtAuth', bearerJwtAuthScheme);

  return app;
}
