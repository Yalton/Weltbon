/**
 * Plan D Task 3 — the outbound sync client. Pure: no DB; fetch is injected (D-05).
 */
import { describe, it, expect } from 'vitest';
import { SyncRemoteClient } from '../src/services/sync/remote-client.js';
import {
  SyncApplyRejectedError,
  SyncAuthError,
  SyncIncompatibleError,
  SyncPaymentError,
  SyncQuotaError,
  SyncUnreachableError,
  safeErrorSummary,
} from '../src/services/sync/run-errors.js';

const IDENTITY = { weltbonVersion: '2.2.0', appVersion: '0.1.0', migrationHead: '0035_x' };

/** Records every call and replies with whatever the scenario queued. */
function stub(reply: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = async (url: string, init?: RequestInit) => {
    calls.push({ url, init: init ?? {} });
    return await reply(url, init ?? {});
  };
  return { calls, fetchImpl };
}

function client(fetchImpl: any, opts: Record<string, unknown> = {}) {
  return new SyncRemoteClient({ baseUrl: 'https://peer.example', pat: 'wbn_pat_secret', fetchImpl, ...opts });
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

describe('SyncRemoteClient transport invariants', () => {
  it('sends the PAT as a bearer header and nowhere else', async () => {
    const { calls, fetchImpl } = stub(() => json({ ok: true, remote: IDENTITY }));
    await client(fetchImpl).handshake(IDENTITY);

    const { url, init } = calls[0];
    expect(url).toBe('https://peer.example/api/sync/handshake');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer wbn_pat_secret');
    expect(url).not.toContain('wbn_pat_secret');
    expect(String(init.body ?? '')).not.toContain('wbn_pat_secret');
  });

  it('never follows redirects — a redirect is how an allowed host pivots to a blocked one', async () => {
    const { calls, fetchImpl } = stub(() => json({ ok: true, remote: IDENTITY }));
    await client(fetchImpl).handshake(IDENTITY);
    expect(calls[0].init.redirect).toBe('manual');
  });

  it('treats a 3xx as unreachable rather than chasing it', async () => {
    const { fetchImpl } = stub(() => new Response('', { status: 302, headers: { Location: 'http://169.254.169.254/' } }));
    await expect(client(fetchImpl).handshake(IDENTITY)).rejects.toBeInstanceOf(SyncUnreachableError);
  });

  it('attaches an abort signal', async () => {
    const { calls, fetchImpl } = stub(() => json({ ok: true, remote: IDENTITY }));
    await client(fetchImpl).handshake(IDENTITY);
    expect(calls[0].init.signal).toBeInstanceOf(AbortSignal);
  });

  it('wraps a transport throw as SyncUnreachableError', async () => {
    const fetchImpl = async () => {
      throw new Error('ECONNREFUSED');
    };
    await expect(client(fetchImpl).handshake(IDENTITY)).rejects.toBeInstanceOf(SyncUnreachableError);
  });

  it('aborts a response that exceeds the byte cap', async () => {
    const { fetchImpl } = stub(() => json({ blob: 'x'.repeat(5000) }));
    await expect(client(fetchImpl, { maxJsonBytes: 100 }).snapshot('u-1')).rejects.toThrow(/too large|exceeded/i);
  });

  it('rejects via the declared content-length fast path before reading any bytes', async () => {
    // new Response(string) does not populate content-length, so the streaming
    // over-cap test above never exercises this branch — a regression flipping
    // `>` to `>=` or dropping the check entirely would be invisible without it.
    const { fetchImpl } = stub(
      () =>
        new Response('{}', {
          status: 200,
          headers: { 'Content-Type': 'application/json', 'Content-Length': '1000' },
        }),
    );
    await expect(client(fetchImpl, { maxJsonBytes: 100 }).snapshot('u-1')).rejects.toThrow(/too large|exceeded/i);
  });
});

describe('SyncRemoteClient status mapping', () => {
  it.each([
    [401, SyncAuthError],
    [403, SyncAuthError],
    [402, SyncPaymentError],
    [413, SyncQuotaError],
  ])('maps %i to a typed error', async (status, ctor) => {
    const { fetchImpl } = stub(() => json({ error: 'nope' }, status));
    await expect(client(fetchImpl).snapshot('u-1')).rejects.toBeInstanceOf(ctor as any);
  });

  it('maps a handshake 409 to SyncIncompatibleError carrying both identities', async () => {
    const remote = { ...IDENTITY, migrationHead: '0034_older' };
    const { fetchImpl } = stub(() => json({ error: 'mismatch', local: IDENTITY, remote }, 409));
    const err = await client(fetchImpl).handshake(IDENTITY).catch((e) => e);
    expect(err).toBeInstanceOf(SyncIncompatibleError);
    expect(err.remote.migrationHead).toBe('0034_older');
  });

  it('returns null for a snapshot 404 rather than throwing', async () => {
    const { fetchImpl } = stub(() => json({ error: 'Universe not found' }, 404));
    expect(await client(fetchImpl).snapshot('u-1')).toBeNull();
  });

  it('sanitizes a hostile handshake 409 identity rather than echoing it (D-09/D-16)', async () => {
    const hostile = {
      weltbonVersion: 'LEAKED-SECRET-TEXT '.repeat(200),
      appVersion: 'x',
      migrationHead: 'y',
    };
    const { fetchImpl } = stub(() => json({ error: 'mismatch', local: IDENTITY, remote: hostile }, 409));
    const err = await client(fetchImpl).handshake(IDENTITY).catch((e) => e);

    expect(err).toBeInstanceOf(SyncIncompatibleError);
    expect(err.remote).toBeNull();
    expect(safeErrorSummary(err)).not.toContain('LEAKED-SECRET-TEXT');
  });

  it('rejects a successful handshake carrying a malformed identity rather than returning it (D-16)', async () => {
    const hostile = { weltbonVersion: 'LEAKED-SECRET-TEXT '.repeat(200), appVersion: 'x', migrationHead: 'y' };
    const { fetchImpl } = stub(() => json({ ok: true, remote: hostile }));
    const err = await client(fetchImpl).handshake(IDENTITY).catch((e) => e);

    expect(err).toBeInstanceOf(SyncUnreachableError);
    expect(String((err as Error).message)).not.toContain('LEAKED-SECRET-TEXT');
  });

  it('keeps only Plan C sanitized fields off a rejected apply (D-09)', async () => {
    const { fetchImpl } = stub(() =>
      json(
        {
          error: 'Cross-universe id collision — some incoming ids already exist in another universe',
          collisions: [{ collection: 'entries', count: 2 }],
          somethingElse: 'a-foreign-universe-uuid-leaked-here',
        },
        409,
      ),
    );
    const err = await client(fetchImpl)
      .apply('u-1', { weltbonVersion: '2.2.0', universe: null, ops: {} })
      .catch((e) => e);

    expect(err).toBeInstanceOf(SyncApplyRejectedError);
    expect(err.detail.collisions).toEqual([{ collection: 'entries', count: 2 }]);
    // Anything not on Plan C's sanitized contract is dropped, and the operator
    // summary that lands in sync_links.last_error must not carry it either.
    expect(JSON.stringify(err.detail)).not.toContain('a-foreign-universe-uuid-leaked-here');
    expect(safeErrorSummary(err)).not.toContain('a-foreign-universe-uuid-leaked-here');
  });

  it('carries missingAssetHashes off an apply 409', async () => {
    const hash = 'a'.repeat(64);
    const { fetchImpl } = stub(() => json({ error: 'Asset bytes missing', missingAssetHashes: [hash] }, 409));
    const err = await client(fetchImpl)
      .apply('u-1', { weltbonVersion: '2.2.0', universe: null, ops: {} })
      .catch((e) => e);
    expect(err.detail.missingAssetHashes).toEqual([hash]);
  });

  it('batches a missing-assets query at the route cap of 5000', async () => {
    const hashes = Array.from({ length: 5001 }, (_, i) => i.toString(16).padStart(64, '0'));
    const seen: number[] = [];
    const { fetchImpl } = stub(async (_url, init) => {
      seen.push(JSON.parse(String(init.body)).hashes.length);
      return json({ missing: [] });
    });
    await client(fetchImpl).missingAssets('u-1', hashes);
    expect(seen).toEqual([5000, 1]);
  });

  /**
   * The `missing` array is peer-controlled and nothing downstream re-checks it:
   * it reaches storage keys via syncBlobKey and reconcile.ts's `unrepairable`,
   * which the Plan E UI renders. Validated exactly as sanitizeApplyDetail
   * validates its own hash array (C-21).
   */
  it('drops anything that is not a sha256 hex digest from a missing-assets reply', async () => {
    const hash = 'a'.repeat(64);
    const { fetchImpl } = stub(() =>
      json({
        missing: [
          hash,
          '../../../etc/passwd',
          'A'.repeat(64), // right length, wrong case
          'a'.repeat(63), // one short
          42,
          null,
          { nested: 'object' },
        ],
      }),
    );
    const out = await client(fetchImpl).missingAssets('u-1', [hash]);
    expect(out).toEqual([hash]);
  });

  it('treats a missing-assets reply whose `missing` is not an array as empty', async () => {
    const { fetchImpl } = stub(() => json({ missing: 'everything' }));
    await expect(client(fetchImpl).missingAssets('u-1', ['a'.repeat(64)])).resolves.toEqual([]);
  });

  it('getBlob reports a 404 as blob-unavailable, not as an unreachable remote (E-08)', async () => {
    const { SyncRemoteClient } = await import('../src/services/sync/remote-client.js');
    const { SyncBlobUnavailableError } = await import('../src/services/sync/run-errors.js');

    const hash = 'a'.repeat(64);
    const client = new SyncRemoteClient({
      baseUrl: 'https://peer.example',
      pat: 'pat_test',
      fetchImpl: async () => new Response('Blob not found', { status: 404 }),
    });

    const err = await client.getBlob('11111111-1111-1111-1111-111111111111', hash).catch((e) => e);
    expect(err).toBeInstanceOf(SyncBlobUnavailableError);
    expect(err.hashes).toEqual([hash]);
    // The fixture gives the 404 a body on purpose: what lands in
    // sync_links.last_error must be OUR string (D-09), and it must name the
    // remote side so the operator is told to retry rather than to re-upload.
    expect(safeErrorSummary(err)).toBe('blob-unavailable: 1 asset blob(s) the remote no longer has');
  });

  it('getBlob still reports a non-404 error status as unreachable', async () => {
    const { SyncRemoteClient } = await import('../src/services/sync/remote-client.js');
    const { SyncUnreachableError } = await import('../src/services/sync/run-errors.js');

    const client = new SyncRemoteClient({
      baseUrl: 'https://peer.example',
      pat: 'pat_test',
      fetchImpl: async () => new Response('boom', { status: 500 }),
    });

    await expect(client.getBlob('11111111-1111-1111-1111-111111111111', 'b'.repeat(64)))
      .rejects.toBeInstanceOf(SyncUnreachableError);
  });
});

describe('safeErrorSummary (D-09)', () => {
  it('summarizes by code, never by remote body text', () => {
    expect(safeErrorSummary(new SyncAuthError())).toContain('remote-unauthorized');
    expect(safeErrorSummary(new Error('raw remote text with <secrets>'))).toBe('unexpected-error');
  });
});
