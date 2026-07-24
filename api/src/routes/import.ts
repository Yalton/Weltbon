import { OpenAPIHono, z } from '@hono/zod-openapi';
import { importUniverseJson, importSchema, INCOMPATIBLE_VERSION_MESSAGE } from '../services/import-json.js';
import type { AuthVariables } from '../middleware/auth.js';
import { ZodError } from 'zod';
import yauzl from 'yauzl';

type AppEnv = { Variables: AuthVariables };

// ─── Response schemas ────────────────────────────────────────────────────────

const importResultSchema = z.object({
  universeId: z.string(),
  universeName: z.string(),
  entryCount: z.number(),
  linkCount: z.number(),
  categoryCount: z.number(),
  issueCount: z.number(),
  positionCount: z.number(),
  pinCount: z.number(),
  assetCount: z.number().optional(),
});

const errorSchema = z.object({ error: z.string() });

// ─── ZIP import constants (RESEARCH.md Zip-Bomb / Decompression Ratio Defense) ──

/** Allow-list: manifest.json and assets/<uuid>.<ext> only. */
const VALID_ZIP_ENTRY = /^(manifest\.json|assets\/[a-f0-9-]+\.(png|jpe?g|webp|gif))$/i;

/** Max entries to extract from an import ZIP (manifest + up to 999 assets). */
const MAX_ZIP_FILES = 1000;
/** Max uncompressed size per file: 10MB (matches per-asset upload cap D-10). */
const MAX_ZIP_FILE_SIZE = 10 * 1024 * 1024;
/** Max total uncompressed bytes across all entries: 600MB. */
const MAX_ZIP_TOTAL = 600 * 1024 * 1024;

/**
 * Parse a ZIP buffer with yauzl, enforcing bomb limits and path-traversal
 * defense (T-38-40, T-38-41). Returns a map of validated entry names → bytes.
 *
 * Cloned from ingest-zip.ts unpackZip() with limits tuned for asset content.
 */
function unpackImportZip(buffer: Buffer): Promise<Map<string, Buffer>> {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(buffer, { lazyEntries: true }, (err, zipfile) => {
      if (err || !zipfile) {
        reject(err ?? new Error('yauzl.fromBuffer returned no zipfile'));
        return;
      }

      const result = new Map<string, Buffer>();
      let fileCount = 0;
      let totalUncompressed = 0;
      let settled = false;

      const settle = (fn: () => void) => {
        if (settled) return;
        settled = true;
        try { zipfile.close(); } catch { /* ignore */ }
        fn();
      };

      zipfile.on('error', (e) => settle(() => reject(e)));
      zipfile.on('end', () => settle(() => resolve(result)));

      zipfile.on('entry', (entry: yauzl.Entry) => {
        // Skip directory entries.
        if (/\/$/.test(entry.fileName)) {
          zipfile.readEntry();
          return;
        }

        // Path-traversal defense (T-38-41): validate entry name against allow-list FIRST.
        if (!VALID_ZIP_ENTRY.test(entry.fileName) || entry.fileName.includes('..')) {
          // Skip unrecognised entries silently (don't fail — callers may add extra files).
          zipfile.readEntry();
          return;
        }

        // ZIP bomb defense (T-38-40): file count cap.
        fileCount += 1;
        if (fileCount > MAX_ZIP_FILES) {
          settle(() => reject(new Error(`ZIP import exceeds max file count (${MAX_ZIP_FILES})`)));
          return;
        }

        // Per-file size preflight via uncompressedSize header.
        if (
          typeof entry.uncompressedSize === 'number' &&
          entry.uncompressedSize > MAX_ZIP_FILE_SIZE
        ) {
          settle(() => reject(new Error(`ZIP entry too large: ${entry.fileName}`)));
          return;
        }

        zipfile.openReadStream(entry, (streamErr, readStream) => {
          if (streamErr || !readStream) {
            settle(() => reject(streamErr ?? new Error('openReadStream returned null')));
            return;
          }

          const chunks: Buffer[] = [];
          let entryBytes = 0;

          readStream.on('data', (raw) => {
            if (settled) return;
            const chunk = raw as Buffer;
            entryBytes += chunk.length;
            totalUncompressed += chunk.length;

            // Live per-file cap.
            if (entryBytes > MAX_ZIP_FILE_SIZE) {
              readStream.destroy();
              settle(() => reject(new Error(`ZIP entry exceeds size limit: ${entry.fileName}`)));
              return;
            }
            // Cumulative cap (D-15b style).
            if (totalUncompressed > MAX_ZIP_TOTAL) {
              readStream.destroy();
              settle(() => reject(new Error('ZIP import exceeds total uncompressed size limit')));
              return;
            }
            chunks.push(chunk);
          });

          readStream.on('error', (e) => settle(() => reject(e)));

          readStream.on('end', () => {
            if (settled) return;
            result.set(entry.fileName, Buffer.concat(chunks));
            zipfile.readEntry();
          });
        });
      });

      zipfile.readEntry();
    });
  });
}

// ─── Shared error handler ─────────────────────────────────────────────────────

function handleImportError(err: unknown): { status: 400 | 500; body: object } {
  if (err instanceof ZodError) {
    const issues = err.issues as Array<{ path: Array<string | number>; message: string }>;
    const versionError = issues.find((e) => e.path.includes('weltbon_version'));
    if (versionError) {
      // This message SHADOWS the Zod one on every import route, so it is what the
      // user actually reads. Shared with the refine (ACCEPTED_EXPORT_VERSIONS) so
      // the two can no longer drift — a hand-copied list here went stale for three
      // manifest versions before anyone noticed.
      return { status: 400, body: { error: INCOMPATIBLE_VERSION_MESSAGE } };
    }
    return { status: 400, body: { error: 'Invalid import format', details: issues } };
  }
  if (err instanceof Error && err.message.includes('unknown entry ID')) {
    return { status: 400, body: { error: err.message } };
  }
  throw err;
}

// ─── Router ──────────────────────────────────────────────────────────────────

export const importRoutes = new OpenAPIHono<AppEnv>()

  // Phase 38 MEDIA-06 (D-07): Plain .post() registered BEFORE the .openapi() route.
  // This intercepts ALL POST / requests before OpenAPIHono's body validator runs,
  // which is critical for multipart/form-data (ZIP) requests — the openapi() validator
  // would validate the body as application/json (getting undefined) and return 400
  // before our handler logic ever executes. The plain .post() bypasses that entirely.
  .post('/', async (c) => {
    const userId = c.var.userId;
    const contentType = c.req.header('content-type') ?? '';

    try {
      if (contentType.includes('multipart/form-data')) {
        // ── ZIP import path (Phase 38 MEDIA-06 D-07) ──
        const body = await c.req.parseBody();
        const zipFile = body['file'];
        if (!(zipFile instanceof File)) {
          return c.json({ error: 'No file field in multipart body' }, 400);
        }

        const zipBytes = Buffer.from(await zipFile.arrayBuffer());

        // Extract all valid entries from the ZIP (path-traversal + bomb limits applied).
        let zipEntries: Map<string, Buffer>;
        try {
          zipEntries = await unpackImportZip(zipBytes);
        } catch (zipErr) {
          const msg = zipErr instanceof Error ? zipErr.message : 'ZIP extraction failed';
          return c.json({ error: msg }, 400);
        }

        const manifestBytes = zipEntries.get('manifest.json');
        if (!manifestBytes) {
          return c.json({ error: 'ZIP does not contain manifest.json' }, 400);
        }

        let manifest: unknown;
        try {
          manifest = JSON.parse(manifestBytes.toString('utf8'));
        } catch {
          return c.json({ error: 'manifest.json is not valid JSON' }, 400);
        }

        // Build asset bytes map: old UUID → Buffer (keyed by UUID, not full path).
        const assetBytesMap = new Map<string, Buffer>();
        for (const [entryName, bytes] of zipEntries) {
          if (entryName.startsWith('assets/')) {
            // Entry name: assets/<uuid>.<ext> → extract UUID.
            const basename = entryName.slice('assets/'.length);
            const dotIdx = basename.lastIndexOf('.');
            const uuid = dotIdx >= 0 ? basename.slice(0, dotIdx) : basename;
            assetBytesMap.set(uuid, bytes);
          }
        }

        const result = await importUniverseJson(userId, manifest, assetBytesMap);
        return c.json(result, 201);

      } else {
        // ── Legacy JSON path ──
        let rawBody: unknown;
        try {
          rawBody = await c.req.json();
        } catch {
          return c.json({ error: 'Request body must be valid JSON or multipart/form-data ZIP' }, 400);
        }
        const result = await importUniverseJson(userId, rawBody);
        return c.json(result, 201);
      }
    } catch (err) {
      const { status, body } = handleImportError(err);
      return c.json(body as any, status);
    }
  })

