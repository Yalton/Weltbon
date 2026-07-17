/**
 * Base-snapshot storage (Plan A — sync spec "Data model").
 * The base is the universe's state as of the last successful sync with one
 * remote, stored as gzip JSON in the existing storageBackend under a
 * link-scoped key. Content shape is the export payload (typed in Plan A2/B —
 * `unknown` here on purpose; this module is a dumb blob store).
 */
import { gzipSync, gunzipSync } from 'node:zlib';
import { storageBackend } from '../storage/local.js';

export function baseSnapshotKey(linkId: string): string {
  return `sync-base-${linkId}`;   // uuid chars + dashes — passes storage safeJoin
}

export async function saveBaseSnapshot(linkId: string, payload: unknown): Promise<void> {
  const buf = gzipSync(Buffer.from(JSON.stringify(payload), 'utf8'));
  await storageBackend.put(baseSnapshotKey(linkId), buf);
}

export async function loadBaseSnapshot(linkId: string): Promise<unknown | null> {
  const buf = await storageBackend.get(baseSnapshotKey(linkId));
  if (!buf) return null;
  return JSON.parse(gunzipSync(buf).toString('utf8'));
}

export async function deleteBaseSnapshot(linkId: string): Promise<void> {
  await storageBackend.delete(baseSnapshotKey(linkId));
}
