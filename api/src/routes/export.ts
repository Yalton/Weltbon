import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { requireUniverse } from '../utils/ownership.js';
import { exportUniverseJson } from '../services/export/json.js';
import { buildMarkdownZip } from '../services/export/markdown.js';
import { renderUniversePdf } from '../services/export/pdf/render.js';
import { renderUniverseDocx } from '../services/export/docx/render.js';
import { loadUniverseExportPayload } from '../services/export/payload.js';
import { exportFilename } from '../services/export/slug.js';
import { env } from '../config.js';
import type { AuthVariables } from '../middleware/auth.js';

type AppEnv = { Variables: AuthVariables };

// ─── Path param and query schemas (D-02) ─────────────────────────────────────

const uidParams = z.object({ uid: z.string().uuid() });

const exportQuerySchema = z.object({
  format: z.enum(['json', 'markdown', 'pdf', 'docx']).optional().default('json'),
});

const errorSchema = z.object({ error: z.string() });


/**
 * /universes/:uid/export — switches on ?format= query.
 *
 * Plans 04-02 (markdown), 04-03 (pdf), 04-04 (docx) each replace ONE 503
 * branch below with their handler call. The minimal-diff layout means the
 * three Wave 2 plans never fight over the same file when they run in
 * parallel.
 *
 * Default format is json (no ?format query) — preserves existing client
 * behavior. Cross-tenant authorization happens up front via requireUniverse.
 */
const exportRoute = createRoute({
  method: 'get',
  path: '/',
  tags: ['Export'],
  summary: 'Export a universe',
  description:
    'Exports the universe in the requested format. ' +
    'JSON returns the full universe payload. ' +
    'Markdown, PDF, and DOCX return binary file downloads. ' +
    'Defaults to JSON if ?format is omitted.',
  security: [{ bearerAuth: [] }],
  request: {
    params: uidParams,
    query: exportQuerySchema,
  },
  responses: {
    200: {
      content: {
        'application/json': {

          schema: z.any(),
        },
        'application/zip': {
          schema: z.any(),
          description: 'Markdown ZIP archive (format=markdown)',
        },
        'application/pdf': {
          schema: z.any(),
          description: 'PDF document (format=pdf)',
        },
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document': {
          schema: z.any(),
          description: 'DOCX document (format=docx)',
        },
      },
      description: 'Universe export in the requested format',
    },
    400: {
      content: { 'application/json': { schema: errorSchema } },
      description: 'Unsupported format',
    },
    401: {
      content: { 'application/json': { schema: errorSchema } },
      description: 'Unauthorized',
    },
    404: {
      content: { 'application/json': { schema: errorSchema } },
      description: 'Universe not found',
    },
    500: {
      content: { 'application/json': { schema: errorSchema } },
      description: 'Internal error',
    },
    501: {
      content: { 'application/json': { schema: errorSchema } },
      description: 'PDF export unavailable in this build (DV-14)',
    },
  },
});


export const exportRoutes = new OpenAPIHono<AppEnv>().openapi(exportRoute, async (c) => {
  const { uid } = c.req.valid('param');
  const universe = await requireUniverse(uid, c.var.userId);
  const format = c.req.valid('query').format ?? c.req.query('format') ?? 'json';

  if (format === 'json') {
    // The filename changes from .json to .zip; Content-Type is application/zip.
    const stream = await exportUniverseJson(uid);
    c.header('Content-Type', 'application/zip');
    c.header(
      'Content-Disposition',
      `attachment; filename="${exportFilename(universe.name, 'zip')}"`,
    );
    return c.body(stream);
  }
  if (format === 'markdown') {
    const payload = await loadUniverseExportPayload(uid);
    c.header('Content-Type', 'application/zip');
    c.header(
      'Content-Disposition',
      `attachment; filename="${exportFilename(universe.name, 'zip')}"`,
    );
    return c.body(buildMarkdownZip(payload));
  }
  if (format === 'pdf') {
    // DV-14: the PDF renderer drives a SYSTEM Chromium via puppeteer-core, which
    if (env().localMode) {
      return c.json(
        { error: 'PDF export is not available in the desktop app. Use ZIP or Markdown export instead.' },
        501
      );
    }
    const payload = await loadUniverseExportPayload(uid);
    c.header('Content-Type', 'application/pdf');
    c.header(
      'Content-Disposition',
      `attachment; filename="${exportFilename(universe.name, 'pdf')}"`,
    );
    return c.body(await renderUniversePdf(payload));
  }
  if (format === 'docx') {
    const payload = await loadUniverseExportPayload(uid);
    c.header(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    );
    c.header(
      'Content-Disposition',
      `attachment; filename="${exportFilename(universe.name, 'docx')}"`,
    );
    const bytes = await renderUniverseDocx(payload);
    return c.body(bytes);
  }
  return c.json({ error: `Unsupported format: ${format}` }, 400);
});
