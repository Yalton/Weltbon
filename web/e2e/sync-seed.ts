/**
 * Shared plumbing for the two-instance sync e2e run (Plan F, Task 5).
 *
 * Unlike `seed.ts` (which talks to the single production stack on :3000), this
 * addresses the TWO-INSTANCE dev rig from docs/sync-dev-rig.md:
 *
 *   - Instance A — the instance under test. API on :3000 (a host `tsx watch`),
 *     UI on :5173 (Vite). Database `db-a`, published on localhost:5441.
 *   - Instance B — the peer. API + baked UI on :3001 (containerized).
 *     Database `db-b`, NOT published — reached with `docker compose exec`.
 *
 * The two share nothing: separate users tables, separate invite codes, separate
 * JWT secrets. Everything here is therefore parameterized by instance.
 *
 * WHY INVITE CODES ARE MINTED PER RUN. `invite_codes` rows are single-use, and
 * the rig's seeded `local-invite-code` / `peer-invite-code` are consumed by the
 * first registration on each instance — which the manual rig walkthrough
 * already did. Reusing them fails with "Invalid or used invite code". So this
 * mints a fresh code straight into each database, exactly as `global-setup.ts`
 * does for the share suite.
 */

import { execSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../..');

export const SYNC_SEED_FILE = resolve(here, 'sync-seed.json');

/** Instance A: the UI under test. */
export const A_UI = process.env.SYNC_E2E_A_UI || 'http://localhost:5173';
export const A_API = process.env.SYNC_E2E_A_API || 'http://localhost:3000/api';
/** Instance B: the peer. Its UI and API share an origin (baked SPA). */
export const B_UI = process.env.SYNC_E2E_B_UI || 'http://localhost:3001';
export const B_API = `${B_UI}/api`;

export const PASSWORD = 'longenoughpw12';

export interface SyncSeed {
  /** Instance A. */
  aEmail: string;
  aToken: string;
  universeId: string;
  universeName: string;
  entryId: string;
  entryTitle: string;
  assetId: string;
  assetFilename: string;
  /** Instance B. */
  bEmail: string;
  bToken: string;
  /** Plaintext PAT minted on B — what A's remote is configured with. */
  pat: string;
}

function sh(cmd: string): string {
  return execSync(cmd, { encoding: 'utf8' }).trim();
}

/** db-a publishes 5441 on the host (docker-compose.dev.yml). */
export function psqlA(query: string): string {
  return sh(
    `PGPASSWORD=devpassword psql -h 127.0.0.1 -p 5441 -U weltbon -d weltbon -tAc ${JSON.stringify(query)}`,
  );
}

/** db-b publishes NO host port by design — go in through the container. */
export function psqlB(query: string): string {
  return sh(
    `docker compose -f ${repoRoot}/docker-compose.dev.yml exec -T db-b psql -U weltbon -d weltbon -tAc ${JSON.stringify(query)}`,
  );
}

/** Insert a fresh single-use invite code and return its plaintext. */
export function mintInvite(psql: (q: string) => string, label: string): string {
  const body = randomBytes(32).toString('base64url');
  const plain = `wbn_inv_${body}`;
  const hash = createHash('sha256').update(plain).digest('hex');
  psql(
    `insert into invite_codes (label, hash, body_suffix) values ('${label}', '${hash}', '${body.slice(-3)}')`,
  );
  return plain;
}

export async function api(
  base: string,
  token: string | null,
  method: string,
  path: string,
  body?: unknown,
): Promise<any> {
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  let payload: BodyInit | undefined;
  if (body instanceof FormData) {
    payload = body;
  } else if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const res = await fetch(`${base}${path}`, { method, headers, body: payload });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`${method} ${base}${path} → ${res.status} ${text.slice(0, 500)}`);
  }
  return text ? JSON.parse(text) : null;
}

/** A 1×1 PNG — small, but a genuine image the API's magic-number check accepts. */
export const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);
