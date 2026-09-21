import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';

vi.mock('../src/db/client.js', () => ({ db: vi.fn() }));
vi.mock('../src/config.js', () => ({ env: vi.fn() }));
vi.mock('../src/services/crypto.js', () => ({ decryptSecret: vi.fn() }));
vi.mock('../src/services/sync/snapshot.js', () => ({ buildSyncManifest: vi.fn() }));
vi.mock('../src/services/sync/base-snapshot.js', () => ({
  saveBaseSnapshot: vi.fn(),
  loadBaseSnapshot: vi.fn(),
}));
vi.mock('../src/services/sync/link-state.js', () => ({
  claimLink: vi.fn(),
  releaseLink: vi.fn(),
}));
vi.mock('../src/services/sync/apply.js', () => ({ applyManifestOps: vi.fn() }));
vi.mock('../src/services/sync/reconcile.js', () => ({
  isWellFormedHash: vi.fn(() => false),
  reconcileAssets: vi.fn(),
}));
vi.mock('../src/services/sync/materialize.js', () => ({
  writeAssetBytes: vi.fn(),
  finalizeMaterialization: vi.fn(),
  discardWrittenAssets: vi.fn(),
  repairThumbSizes: vi.fn(),
}));
vi.mock('../src/services/sync/conflicts.js', () => ({ recordConflicts: vi.fn() }));

const remoteClientMocks = {
  handshake: vi.fn(),
  snapshot: vi.fn(),
  apply: vi.fn(),
};
vi.mock('../src/services/sync/remote-client.js', () => ({
  SyncRemoteClient: vi.fn().mockImplementation(() => remoteClientMocks),
}));

import { db } from '../src/db/client.js';
import { env } from '../src/config.js';
import { decryptSecret } from '../src/services/crypto.js';
import { buildSyncManifest } from '../src/services/sync/snapshot.js';
import { saveBaseSnapshot, loadBaseSnapshot } from '../src/services/sync/base-snapshot.js';
import { claimLink, releaseLink } from '../src/services/sync/link-state.js';
import { applyManifestOps } from '../src/services/sync/apply.js';
import { reconcileAssets } from '../src/services/sync/reconcile.js';
import {
  writeAssetBytes,
  finalizeMaterialization,
  repairThumbSizes,
} from '../src/services/sync/materialize.js';
import { recordConflicts } from '../src/services/sync/conflicts.js';
import { runSync } from '../src/services/sync/run-sync.js';
import { SyncIncompatibleError } from '../src/services/sync/run-errors.js';
import { COLLECTIONS } from '../src/services/sync/manifest.js';

const LINK_ID = 'link-1';
const OWNER_ID = 'owner-1';
const UNIVERSE_ID = 'universe-1';
const REMOTE_ID = 'remote-1';

const fakeLink = {
  id: LINK_ID,
  universeId: UNIVERSE_ID,
  remoteId: REMOTE_ID,
  baseSnapshotKey: null,
  lastSyncedAt: null,
  status: 'idle',
  lastError: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

const fakeRemote = {
  id: REMOTE_ID,
  userId: OWNER_ID,
  label: '',
  baseUrl: 'https://peer.example',
  encryptedPat: { ciphertext: '', iv: '', authTag: '', bodySuffix: '', version: 1 as const },
  createdAt: new Date(),
};

/** The chainable fake `db().select(...).from(...).innerJoin(...).innerJoin(...).where(...).limit(1)`. */
function makeFakeDb(rows: unknown[]) {
  const chain: any = {};
  for (const m of ['select', 'from', 'innerJoin', 'where', 'limit']) {
    chain[m] = () => chain;
  }
  chain.then = (resolve: (v: unknown) => void, reject?: (e: unknown) => void) =>
    Promise.resolve(rows).then(resolve, reject);
  return { select: () => chain };
}

function emptyManifest(version: string) {
  const out: Record<string, unknown> = {
    weltbon_version: version,
    exported_at: new Date().toISOString(),
    universe: { id: UNIVERSE_ID, name: 'Test Universe', userId: OWNER_ID },
  };
  for (const { name } of COLLECTIONS) out[name] = [];
  return out;
}

describe('run-sync unit-lane coverage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (db as unknown as Mock).mockReturnValue(
      makeFakeDb([{
        instanceId: '11111111-1111-4111-8111-111111111111',
        link: fakeLink,
        remote: fakeRemote,
        universeOwnerId: OWNER_ID,
      }]),
    );
    (env as unknown as Mock).mockReturnValue({ llmKeyEncryptionKey: '0'.repeat(64) });
    (decryptSecret as unknown as Mock).mockReturnValue('wbn_pat_fake');
    (claimLink as unknown as Mock).mockResolvedValue(undefined);
    (loadBaseSnapshot as unknown as Mock).mockResolvedValue(null);
    (saveBaseSnapshot as unknown as Mock).mockResolvedValue(undefined);
    (applyManifestOps as unknown as Mock).mockResolvedValue({ upserted: {}, deleted: {} });
    (reconcileAssets as unknown as Mock).mockResolvedValue({
      blobsPushed: 0,
      blobsPulled: 0,
      assetsRepairedLocally: 0,
      pushedRows: [],
      toMaterialize: [],
      unrepairable: [],
    });
    (writeAssetBytes as unknown as Mock).mockResolvedValue([]);
    (finalizeMaterialization as unknown as Mock).mockResolvedValue(undefined);
    (repairThumbSizes as unknown as Mock).mockResolvedValue(undefined);
    (recordConflicts as unknown as Mock).mockResolvedValue(0);
    remoteClientMocks.handshake.mockResolvedValue({
      instanceId: '22222222-2222-4222-8222-222222222222',
      weltbonVersion: '2.2.0',
      appVersion: '1.0.0',
      migrationHead: 'deadbeef',
    });
  });

  // ── Scenario 15 ────────────────────────────────────────────────────────

  it('a failed release after a SUCCESSFUL drive does not turn success into a reported failure', async () => {
    (buildSyncManifest as unknown as Mock).mockResolvedValue(emptyManifest('2.2.0'));
    remoteClientMocks.snapshot.mockResolvedValue(null); // bootstrap: peer has never seen the universe
    remoteClientMocks.apply.mockResolvedValue({ upserted: { universe: 1 }, deleted: {} });
    (releaseLink as unknown as Mock).mockRejectedValue(new Error('release UPDATE failed'));

    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await runSync(LINK_ID, OWNER_ID, {});

    // runSync RESOLVES — the drive genuinely succeeded, and a release failure
    // must not be reported as a sync failure (run-sync.ts's own docstring: a
    // failed release leaves status stuck at 'syncing', which is self-healing
    // via the lease/force, and is the cheaper failure than misreporting).
    expect(result.bootstrapped).toBe(true);

    // releaseLink was called with the SUCCESS outcome (not 'error') — proving
    // the failure was NOT misreported as a sync error before being swallowed.
    expect(releaseLink).toHaveBeenCalledTimes(1);
    expect((releaseLink as unknown as Mock).mock.calls[0][1]).toMatchObject({ status: 'idle', lastError: null });

    // The failure was logged, not silently dropped.
    expect(consoleError).toHaveBeenCalledTimes(1);
    const [logLine] = consoleError.mock.calls[0];
    expect(String(logLine)).toContain('releaseLink failed');
    expect(String(logLine)).toContain('status=idle');

    consoleError.mockRestore();
  });

  // ── Scenario 16 ────────────────────────────────────────────────────────

  it('SyncVersionMismatchError from a real mergeManifests call maps to SyncIncompatibleError', async () => {
    // A genuinely impossible peer pairing for two real builds (the handshake
    // is the primary gate against this) — manufactured by hand to drive
    // mergeManifests' own defense-in-depth version gate (B-09).
    (buildSyncManifest as unknown as Mock).mockResolvedValue(emptyManifest('2.2.0'));
    remoteClientMocks.snapshot.mockResolvedValue(emptyManifest('9.9.9'));
    (releaseLink as unknown as Mock).mockResolvedValue(undefined);

    let caught: unknown;
    try {
      await runSync(LINK_ID, OWNER_ID, {});
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(SyncIncompatibleError);
    const err = caught as SyncIncompatibleError;
    expect(err.status).toBe(409);
    expect(err.code).toBe('remote-incompatible');
    expect(err.local.weltbonVersion).toBe('2.2.0');
    expect(err.remote).toBeNull(); // drive() passes null — it never had a real handshake body for this

    // The failure path release ran with status 'error', and the base never advanced.
    expect(releaseLink).toHaveBeenCalledTimes(1);
    expect((releaseLink as unknown as Mock).mock.calls[0][1]).toMatchObject({ status: 'error' });
    expect(saveBaseSnapshot).not.toHaveBeenCalled();
  });

  it('does not report success when the local apply reports fewer rows than the merge required', async () => {
    const local = emptyManifest('2.2.0');
    const remote = emptyManifest('2.2.0');
    (remote.entries as Record<string, unknown>[]).push({
      id: 'entry-1',
      universeId: UNIVERSE_ID,
      title: 'Expected remote entry',
      entryType: 'entity',
      body: '',
      summary: '',
      tags: [],
      meta: {},
      createdAt: '2026-08-20T00:00:00.000Z',
      updatedAt: '2026-08-20T00:00:00.000Z',
    });
    (buildSyncManifest as unknown as Mock).mockResolvedValue(local);
    remoteClientMocks.snapshot.mockResolvedValue(remote);
    remoteClientMocks.apply.mockResolvedValue({ upserted: {}, deleted: {}, sweptAssets: 0 });
    // The merge requires one local entry upsert, but a broken apply reports
    // that it wrote nothing. This is the false-success boundary from #43.
    (applyManifestOps as unknown as Mock).mockResolvedValue({ upserted: {}, deleted: {} });
    (releaseLink as unknown as Mock).mockResolvedValue(undefined);

    await expect(runSync(LINK_ID, OWNER_ID, {})).rejects.toMatchObject({
      code: 'local-materialization-incomplete',
      status: 500,
    });
    expect(saveBaseSnapshot).not.toHaveBeenCalled();
  });
});
