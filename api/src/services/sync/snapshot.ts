import { loadUniverseExportPayload } from '../export/payload.js';
import { buildManifest } from '../export/json.js';
import { ensureAssetHashes } from './asset-hash.js';
import type { SyncManifest } from './manifest.js';

export async function buildSyncManifest(universeId: string): Promise<SyncManifest> {
  await ensureAssetHashes(universeId);
  const payload = await loadUniverseExportPayload(universeId);
  return buildManifest(payload);
}
