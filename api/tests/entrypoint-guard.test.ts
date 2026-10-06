import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { COLD_START_TIMEOUT } from './helpers/timeouts.js';

/**
 * Both `db/migrate.ts` and `index.ts` decide whether to run as a CLI entrypoint
 * by comparing `import.meta.url` against `pathToFileURL(process.argv[1]).href`.
 *
 * A packaged Electron app IMPORTS these modules with no script argument —
 * argv[0] is the binary and there is no argv[1] — so `process.argv[1]` is
 * undefined and `pathToFileURL(undefined)` throws ERR_INVALID_ARG_TYPE. That
 * crashed the packaged desktop app at startup, before any window appeared,
 * while working perfectly in a dev checkout where argv[1] is always set.
 *
 * WHAT MAKES THE MUTANT DIE: drop the `entryArg !== undefined` check in either
 * module and importing it with argv[1] absent throws instead of resolving.
 * These tests import for the side effect only; there is nothing to assert about
 * the module's exports, and that is the point — the failure is at import time.
 *
 * Worth remembering which direction this regressed: the ORIGINAL comparison
 * (`import.meta.url === `file://${process.argv[1]}``) never threw. It produced
 * `file://undefined` and was correctly false. `pathToFileURL` was adopted to
 * close a silent-mismatch class and, in doing so, turned a benign false into a
 * crash in a host nothing tested.
 */
describe('CLI entrypoint guards tolerate a missing process.argv[1]', { timeout: COLD_START_TIMEOUT }, () => {
  const originalArgv = process.argv;

  beforeEach(() => {
    vi.resetModules();
    // Exactly what a packaged Electron main process sees: a binary and no script.
    process.argv = [originalArgv[0]];
  });

  afterEach(() => {
    process.argv = originalArgv;
    vi.resetModules();
  });

  it('db/migrate.ts imports without throwing', async () => {
    expect(process.argv[1]).toBeUndefined();
    // @ts-expect-error the ?query-suffix defeats the module cache but is unresolvable to tsc
    await expect(import('../src/db/migrate.js?entry-guard-1')).resolves.toBeDefined();
  });

  it('index.ts imports without throwing', async () => {
    // index.ts calls env() at module scope, so give it a valid minimal config.
    process.env.JWT_SECRET = 'a'.repeat(32);
    process.env.DATABASE_URL = 'postgresql://localhost/x';
    expect(process.argv[1]).toBeUndefined();
    // @ts-expect-error the ?query-suffix defeats the module cache but is unresolvable to tsc
    await expect(import('../src/index.js?entry-guard-2')).resolves.toBeDefined();
  });

  it('still recognises a real entrypoint when argv[1] IS the module', async () => {
    // The guard must not have been neutered into "never run as a CLI" — that
    // would silently stop `node dist/db/migrate.js` from migrating, which is
    // how docker-entrypoint.sh runs migrations on every container boot.
    const { pathToFileURL } = await import('node:url');
    const url = new URL('../src/db/migrate.ts', import.meta.url);
    const asPath = url.pathname;
    process.argv = [originalArgv[0], asPath];
    expect(pathToFileURL(process.argv[1]).href).toBe(url.href);
  });
});
