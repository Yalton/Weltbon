/**
 * GET /api/version — build identity for a running instance.
 *
 * The point of this route is answering "which build is this?" without a
 * credential: the deploy check that matters is `curl prod/api/version` right
 * after `docker compose up -d`, and a desktop user reporting a bug should be
 * able to read their version off the settings screen the app already renders.
 *
 * NO DB — follows tests/cors.test.ts, which builds the app via createApp() and
 * never touches Postgres. Do NOT add this file to DB_GATED_TESTS.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { COLD_START_TIMEOUT } from './helpers/timeouts.js';

const PKG_VERSION = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
).version as string;

const ENV_KEYS = ['WELTBON_VERSION', 'WELTBON_COMMIT', 'WELTBON_BUILT_AT'] as const;
const saved: Record<string, string | undefined> = {};

interface VersionBody {
  version: string;
  commit: string | null;
  builtAt: string | null;
}

async function versionResponse() {
  vi.resetModules();
  const { createApp } = await import('../src/index.js');
  const app = createApp();
  return app.fetch(new Request('http://localhost/api/version'));
}

/** Typed body reader — `Response.json()` is `unknown`, and every assertion here indexes into it. */
async function versionBody(): Promise<VersionBody> {
  return (await (await versionResponse()).json()) as VersionBody;
}

beforeEach(() => {
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe('GET /api/version', { timeout: COLD_START_TIMEOUT }, () => {
  it('answers without any credential', async () => {
    const res = await versionResponse();
    expect(res.status).toBe(200);
  });

  it('reports the installed package version when nothing is baked in', async () => {
    const res = await versionResponse();
    expect(await res.json()).toMatchObject({ version: PKG_VERSION });
  });

  it('prefers the version baked in at build time over the package version', async () => {
    process.env.WELTBON_VERSION = '9.9.9';
    expect((await versionBody()).version).toBe('9.9.9');
  });

  it('reports the build commit when one was baked in', async () => {
    process.env.WELTBON_COMMIT = 'a1b2c3d';
    expect((await versionBody()).commit).toBe('a1b2c3d');
  });

  /**
   * A dev server has no commit to report. `null` rather than a fabricated value
   * or a missing key: the settings UI branches on it to decide whether to render
   * the sha, and a client cannot branch on a key that is sometimes absent.
   */
  it('reports a null commit rather than omitting the field when unknown', async () => {
    const body = await versionBody();
    expect(body).toHaveProperty('commit');
    expect(body.commit).toBeNull();
  });

  it('reports the build timestamp when one was baked in, and null otherwise', async () => {
    process.env.WELTBON_BUILT_AT = '2026-08-24T00:00:00.000Z';
    expect((await versionBody()).builtAt).toBe('2026-08-24T00:00:00.000Z');

    delete process.env.WELTBON_BUILT_AT;
    expect((await versionBody()).builtAt).toBeNull();
  });

  /**
   * Version disclosure is the deliberate cost of an unauthenticated route. What
   * must NOT leak is anything else about the instance — no env, no paths, no
   * config. Pinning the exact key set makes a careless addition fail here.
   */
  it('exposes exactly three fields and nothing else about the instance', async () => {
    process.env.WELTBON_COMMIT = 'a1b2c3d';
    const body = await versionBody();
    expect(Object.keys(body).sort()).toEqual(['builtAt', 'commit', 'version']);
  });
});
