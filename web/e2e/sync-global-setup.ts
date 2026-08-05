/**
 * Global setup for the sync e2e run (Plan F, Task 5).
 *
 * Creates the fixture data both instances need, via their APIs, and writes it
 * to `e2e/sync-seed.json`. The sync ACTIONS themselves are deliberately NOT
 * done here — they are what the spec drives through instance A's UI, because
 * the UI is what is under test.
 */

import { writeFileSync } from 'node:fs';
import {
  A_API,
  A_UI,
  B_API,
  B_UI,
  PASSWORD,
  SYNC_SEED_FILE,
  TINY_PNG,
  api,
  mintInvite,
  psqlA,
  psqlB,
  type SyncSeed,
} from './sync-seed';

async function reachable(url: string, hint: string) {
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  } catch (e) {
    throw new Error(`${url} is not reachable (${e}). ${hint}`);
  }
}

export default async function syncGlobalSetup() {
  await reachable(
    `${A_API.replace(/\/api$/, '')}/health`,
    "Start instance A's API — see docs/sync-dev-rig.md.",
  );
  await reachable(A_UI, "Start instance A's Vite dev server: cd web && pnpm dev");
  await reachable(
    `${B_UI}/health`,
    'Start instance B: docker compose -f docker-compose.dev.yml up -d',
  );

  const stamp = Date.now();

  // ─── Instance A: user, universe, entry, image ────────────────────────────
  const aEmail = `sync-e2e-a-${stamp}@test.local`;
  const aReg = await api(A_API, null, 'POST', '/auth/register', {
    email: aEmail,
    password: PASSWORD,
    displayName: `Sync A ${stamp}`,
    inviteCode: mintInvite(psqlA, `sync-e2e-${stamp}`),
  });
  const aToken = aReg.accessToken as string;

  const universeName = `Sync E2E ${stamp}`;
  const universe = await api(A_API, aToken, 'POST', '/universes', { name: universeName });

  const entryTitle = `Ferrous Gate ${stamp}`;
  const entry = await api(A_API, aToken, 'POST', `/universes/${universe.id}/entries`, {
    title: entryTitle,
    entryType: 'location',
    body: 'A gate of iron. Written on instance A.',
  });

  // The image is not optional garnish: the asset-carrying first-sync path is
  // the one that used to deadlock, and is the specific reason Plan F0 exists.
  const assetFilename = `gate-${stamp}.png`;
  const form = new FormData();
  form.append('file', new Blob([TINY_PNG], { type: 'image/png' }), assetFilename);
  const asset = await api(A_API, aToken, 'POST', `/universes/${universe.id}/assets`, form);

  // ─── Instance B: user + the PAT instance A will authenticate with ────────
  const bEmail = `sync-e2e-b-${stamp}@test.local`;
  const bReg = await api(B_API, null, 'POST', '/auth/register', {
    email: bEmail,
    password: PASSWORD,
    displayName: `Sync B ${stamp}`,
    inviteCode: mintInvite(psqlB, `sync-e2e-${stamp}`),
  });
  const bToken = bReg.accessToken as string;
  const pat = await api(B_API, bToken, 'POST', '/auth/tokens', { label: `sync-e2e-${stamp}` });

  const seed: SyncSeed = {
    aEmail,
    aToken,
    universeId: universe.id,
    universeName,
    entryId: entry.id,
    entryTitle,
    assetId: asset.id,
    assetFilename,
    bEmail,
    bToken,
    pat: pat.plaintext,
  };
  writeFileSync(SYNC_SEED_FILE, JSON.stringify(seed, null, 2));
}
