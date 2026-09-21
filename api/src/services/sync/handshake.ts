import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { instanceIdentity } from '../../db/schema.js';

export interface InstanceIdentity {
  instanceId: string;
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

export class InstanceIdentityUnavailableError extends Error {
  constructor(cause: string) {
    super(`Cannot determine instance identity: ${cause}`);
    this.name = 'InstanceIdentityUnavailableError';
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

export function resetMigrationHeadCache(): void {
  cachedHead = null;
}

export const WELTBON_MANIFEST_VERSION = '2.2.0';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function localIdentity(): Promise<InstanceIdentity> {
  const head = await migrationHead();
  let rows: Array<{ instanceId: string }>;
  try {
    rows = await db()
      .select({ instanceId: instanceIdentity.instanceId })
      .from(instanceIdentity)
      .where(eq(instanceIdentity.singleton, true));
  } catch (err) {
    throw new InstanceIdentityUnavailableError((err as Error).message);
  }
  if (rows.length !== 1) {
    throw new InstanceIdentityUnavailableError(`expected one singleton row, found ${rows.length}`);
  }
  if (!UUID_RE.test(rows[0].instanceId)) {
    throw new InstanceIdentityUnavailableError('singleton row contains a malformed UUID');
  }
  return {
    instanceId: rows[0].instanceId,
    weltbonVersion: WELTBON_MANIFEST_VERSION,
    appVersion: process.env.npm_package_version ?? '0.1.0',
    migrationHead: head,
  };
}
