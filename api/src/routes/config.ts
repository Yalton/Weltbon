/**
 * Issue #48 Task 6 — GET /api/config: instance-level facts the shared
 * frontend branches on before it knows anything about the logged-in user.
 *
 * Deliberately the smallest possible surface: today it carries exactly one
 * field, `localMode`. That is what lets `web/`'s single build (desktop AND
 * hosted ship the identical bundle) decide at runtime whether to render the
 * Ollama connection settings section (Task 7) — a hosted deployment must not
 * even show the control, let alone accept a request through it (routes/
 * llm-connections.ts is the server-side half of that same decision, gated on
 * the same `env().localMode`).
 *
 * Unauthenticated by design: the frontend needs this before the user has
 * logged in (it affects which settings sections even exist), and the value
 * carries no per-user or per-installation secret — it is a boolean baked in
 * at deploy time via WELTBON_LOCAL_MODE.
 */
import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { env } from '../config.js';

const configSchema = z.object({ localMode: z.boolean() });

const getConfigRoute = createRoute({
  method: 'get',
  path: '/',
  tags: ['config'],
  summary: 'Instance-level facts the shared frontend branches on',
  description:
    'Unauthenticated: it exposes no user data, and the frontend needs it before login ' +
    'to decide which settings sections exist.',
  responses: {
    200: { content: { 'application/json': { schema: configSchema } }, description: 'Instance config.' },
  },
});

export const configRoutes = new OpenAPIHono().openapi(getConfigRoute, (c) =>
  // env() read live, never captured at module scope — mirrors the discipline
  // routes/auth.ts documents for the local-session route (DV-11 / Finding 2):
  // a value captured once at import time would freeze whatever localMode
  // happened to be the first time this module was ever loaded, which is
  // wrong for any process (including tests) that can observe the flag change.
  c.json({ localMode: env().localMode }, 200),
);
