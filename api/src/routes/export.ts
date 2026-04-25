import { Hono } from 'hono';
import { requireUniverse } from '../utils/ownership.js';
import { exportUniverseJson } from '../services/export/json.js';
import { buildMarkdownZip } from '../services/export/markdown.js';
import { renderUniversePdf } from '../services/export/pdf/render.js';
import { renderUniverseDocx } from '../services/export/docx/render.js';
import { loadUniverseExportPayload } from '../services/export/payload.js';
import { exportFilename } from '../services/export/slug.js';
import type { AuthVariables } from '../middleware/auth.js';

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
export const exportRoutes = new Hono<{ Variables: AuthVariables }>().get('/', async (c) => {
  const uid = c.req.param('uid')!;
  const universe = await requireUniverse(uid, c.var.userId);
  const format = c.req.query('format') ?? 'json';

  if (format === 'json') {
    const data = await exportUniverseJson(uid);
    c.header(
      'Content-Disposition',
      `attachment; filename="${exportFilename(universe.name, 'json')}"`,
    );
    return c.json(data);
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
