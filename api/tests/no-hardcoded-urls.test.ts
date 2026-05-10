/**
 * CI guard against hardcoded localhost URLs leaking into production (PROXY-03).
 *
 * Forbidden patterns:
 *   - http://localhost:3000
 *   - http://0.0.0.0:3000
 *   - http://127.0.0.1:3000
 *
 * Verified surfaces:
 *   1. GET /api/openapi.json response body (raw text + parsed doc.servers)
 *   2. Built web-dist/ assets (.html, .js, .css recursive walk)
 *
 * Per CONTEXT.md §"No-hardcoded-localhost CI guard": no new CI job, no pre-commit
 * hook — this test runs as part of `pnpm --filter api test`. The web-dist scan
 * gracefully skips when no build artifact is present (developer machine without a
 * prior `pnpm --filter web build` doesn't fail CI prematurely).
 */

import { describe, it, expect } from 'vitest';
import { readdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { app } from '../src/index.js';

const FORBIDDEN_PATTERNS = [
  'http://localhost:3000',
  'http://0.0.0.0:3000',
  'http://127.0.0.1:3000',
] as const;

/** Locates the built SPA dist directory. Returns null when absent (dev env). */
function findWebDist(): string | null {
  const candidates = [
    resolve(process.cwd(), 'web-dist'),       // Docker layout (api/ ships ./web-dist)
    resolve(process.cwd(), '..', 'web', 'dist'), // monorepo dev layout (web/dist)
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/** Returns the list of files (full paths) matching an extension under root. */
async function listFiles(root: string, extensions: readonly string[]): Promise<string[]> {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  const out: string[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const name = entry.name;
    if (!extensions.some((ext) => name.endsWith(ext))) continue;
    // readdir with recursive:true sets parentPath on Node 20+; fall back to root.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const parent = (entry as any).parentPath ?? (entry as any).path ?? root;
    out.push(join(parent, name));
  }
  return out;
}

describe('No hardcoded localhost URLs in API output or built assets (PROXY-03)', () => {
  describe('GET /api/openapi.json', () => {
    it('Test 1: raw response body contains none of the forbidden localhost patterns', async () => {
      const res = await app.fetch(new Request('http://localhost/api/openapi.json'));
      expect(res.status).toBe(200);
      const raw = await res.text();
      for (const pattern of FORBIDDEN_PATTERNS) {
        expect(raw, `openapi.json must not contain ${pattern}`).not.toContain(pattern);
      }
    });

    it('Test 2: parsed doc.servers entries contain no literal localhost URLs', async () => {
      const res = await app.fetch(new Request('http://localhost/api/openapi.json'));
      const doc = (await res.json()) as { servers?: Array<{ url: string }> };
      if (!doc.servers) return; // schema may omit servers entirely; that's fine.
      for (const server of doc.servers) {
        for (const pattern of FORBIDDEN_PATTERNS) {
          expect(server.url, `servers[].url must not contain ${pattern}`).not.toContain(pattern);
        }
        // Also reject any standalone 'localhost', '0.0.0.0', '127.0.0.1' in server.url
        // (defensive — catches a URL with a different port).
        expect(server.url, 'servers[].url must not contain bare "localhost"').not.toMatch(/localhost/);
        expect(server.url, 'servers[].url must not contain "0.0.0.0"').not.toContain('0.0.0.0');
        expect(server.url, 'servers[].url must not contain "127.0.0.1"').not.toContain('127.0.0.1');
      }
    });
  });

  describe('Built web-dist assets', () => {
    it('Test 3: every .html/.js/.css file under web-dist contains no forbidden localhost patterns', async () => {
      const webDist = findWebDist();
      if (webDist === null) {
        console.warn(
          '[no-hardcoded-urls] web-dist not found at either candidate path; skipping the asset walk. ' +
          'Run `pnpm --filter web build` before this test for full PROXY-03 coverage.'
        );
        expect(true).toBe(true);
        return;
      }
      const files = await listFiles(webDist, ['.html', '.js', '.css']);
      expect(files.length, `web-dist at ${webDist} must contain at least one .html/.js/.css file`).toBeGreaterThan(0);
      for (const file of files) {
        const content = await readFile(file, 'utf-8');
        for (const pattern of FORBIDDEN_PATTERNS) {
          expect(content, `${file} must not contain ${pattern}`).not.toContain(pattern);
        }
      }
    });
  });

  describe('Self-test', () => {
    it('Test 4: FORBIDDEN_PATTERNS contains exactly the three required strings (regression guard)', () => {
      expect(FORBIDDEN_PATTERNS).toHaveLength(3);
      expect(FORBIDDEN_PATTERNS).toContain('http://localhost:3000');
      expect(FORBIDDEN_PATTERNS).toContain('http://0.0.0.0:3000');
      expect(FORBIDDEN_PATTERNS).toContain('http://127.0.0.1:3000');
    });
  });
});
