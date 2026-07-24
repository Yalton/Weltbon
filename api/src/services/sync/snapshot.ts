/**
 * Plan C (C-05): THE entry point for building a manifest destined for sync.
 *
 * Every sync path — this plan's snapshot route and Plan D's base snapshots —
 * must go through here rather than calling buildManifest directly, so both
 * sides of a merge always carry asset content hashes. A manifest built without
 * the hash sweep would compare unequal against one built with it, manufacturing
 * an asset conflict out of nothing.
 *
 * The ZIP export path deliberately does NOT route through here: it ships the
 * bytes themselves, so a null hash costs it nothing.
 */
import { loadUniverseExportPayload } from '../export/payload.js';
import { buildManifest } from '../export/json.js';
import { ensureAssetHashes } from './asset-hash.js';
import type { SyncManifest } from './manifest.js';

export async function buildSyncManifest(universeId: string): Promise<SyncManifest> {
  await ensureAssetHashes(universeId);
  const payload = await loadUniverseExportPayload(universeId);
  return buildManifest(payload);
}
