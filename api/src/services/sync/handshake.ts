/**
 * Plan C (C-14): instance identity for the sync handshake (sync spec S-08).
 *
 * Three values describe compatibility:
 *   weltbonVersion — the manifest format. Merging across versions is refused by
 *                    the engine itself (B-09); the handshake catches it first.
 *   migrationHead  — the last tag in drizzle/meta/_journal.json. Two instances
 *                    at different schema heads can produce manifests that apply
 *                    cleanly and still lose data.
 *   appVersion     — package.json version. Reported for humans; never gates.
 *
 * The journal is read from disk (Dockerfile:61 copies api/drizzle into the
 * runtime image at ./drizzle, relative to cwd) and cached after the first
 * successful read. If it cannot be read the handshake fails LOUDLY — a
 * permissive default would let mismatched instances corrupt each other.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface InstanceIdentity {
  weltbonVersion: string;
  appVersion: string;
  migrationHead: string;
}

export class MigrationHeadUnavailableError extends Error {
  constructor(cause: string) {
    super(`Cannot determine migration head: ${cause}`);
    this.name = 'MigrationHeadUnavailableError';
  }
}

let cachedHead: string | null = null;

export async function migrationHead(): Promise<string> {
  if (cachedHead) return cachedHead;
  const dir = process.env.DRIZZLE_DIR ?? join(process.cwd(), 'drizzle');
  let parsed: { entries?: Array<{ idx: number; tag: string }> };
  try {
    parsed = JSON.parse(await readFile(join(dir, 'meta', '_journal.json'), 'utf8'));
  } catch (err) {
    throw new MigrationHeadUnavailableError((err as Error).message);
  }
  const entries = parsed.entries ?? [];
  if (entries.length === 0) throw new MigrationHeadUnavailableError('journal has no entries');
  const head = entries.reduce((a, b) => (b.idx > a.idx ? b : a));
  cachedHead = head.tag;
  return cachedHead;
}

/** The manifest version this build emits — kept in lockstep with json.ts. */
export const WELTBON_MANIFEST_VERSION = '2.2.0';

export async function localIdentity(): Promise<InstanceIdentity> {
  return {
    weltbonVersion: WELTBON_MANIFEST_VERSION,
    // Read lazily so a bundler/packager change cannot break module load.
    appVersion: process.env.npm_package_version ?? '0.1.0',
    migrationHead: await migrationHead(),
  };
}
