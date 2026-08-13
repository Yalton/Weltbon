import { describe, it, expect } from 'vitest';
import {
  syncErrorMessage,
  lastErrorMessage,
  combineRunError,
  SYNC_ERROR_COPY,
  type SyncCopy,
} from './syncErrorCopy';
import { ApiError } from '../api/client';

describe('SYNC_ERROR_COPY', () => {
  it('maps every known code to copy that is not the code itself', () => {
    // Arming assertion: if a code is ever added to the map with its own id as
    // the copy, this catches it. Without this, a lazy entry passes silently.
    for (const [code, copy] of Object.entries(SYNC_ERROR_COPY)) {
      expect(copy.message).not.toBe(code);
      expect(copy.message.length).toBeGreaterThan(10);
    }
  });

  it('pins this map to exactly 16 keys, so adding/removing one HERE forces a copy decision', () => {
    // This reads SYNC_ERROR_COPY only, never run-errors.ts — there is no
    // shared package and no web→api import, so nothing in `web` can fail
    // when a code is added server-side. A future server code does NOT fail
    // this test; it silently degrades to syncErrorMessage's fallback branch,
    // by design (see that function's comment).
    expect(Object.keys(SYNC_ERROR_COPY).sort()).toEqual([
      'SELF_REMOTE',
      'blob-unavailable',
      'busy',
      'forbidden',
      'link-not-found',
      'remote-incompatible',
      'remote-key-undecryptable',
      'remote-payment-required',
      'remote-quota-exceeded',
      'remote-rejected',
      'remote-unauthorized',
      'remote-universe-forbidden',
      'remote-universe-missing',
      'remote-unreachable',
      'universe-already-local',
      'universe-not-on-remote',
    ]);
  });
});

describe('syncErrorMessage', () => {
  it('routes every one of the 16 codes through syncErrorMessage to written copy, not the bare code', () => {
    // The SYNC_ERROR_COPY tests above only inspect the map directly — they
    // never call syncErrorMessage, so a regression that hardcodes
    // `message: code` inside the function (rather than in the map) would
    // pass them silently. This walks the function itself for every known
    // code.
    for (const [code, copy] of Object.entries(SYNC_ERROR_COPY)) {
      const err = new ApiError(409, { error: 'raw', code }, 'raw');
      const out = syncErrorMessage(err);
      expect(out.message).not.toBe(code);
      expect(out.message).toBe(copy.message);
      // Inside the loop, not in a single-code test: pinning `raw` for one code
      // only leaves the other 11 free to drop it, which is the same
      // one-code-pinned hole this loop exists to close for `message`.
      expect(out.raw).toBe('raw');
    }
  });

  it('flags busy as retryable so the caller can offer Run anyway', () => {
    const err = new ApiError(409, { error: 'raw', code: 'busy' }, 'raw');
    expect(syncErrorMessage(err).canForce).toBe(true);
  });

  it('does not flag any other code as retryable', () => {
    const err = new ApiError(502, { error: 'raw', code: 'remote-unreachable' }, 'raw');
    expect(syncErrorMessage(err).canForce).toBe(false);
  });

  it('explains how to correct a self-remote without offering force', () => {
    // Mutation caught: omitting SELF_REMOTE from the map falls through to the
    // server's terse throw-site message and loses the corrective action.
    const out = syncErrorMessage(
      new ApiError(409, { error: 'self', code: 'SELF_REMOTE' }, 'self'),
    );
    expect(out.message).toMatch(/this Weltbon instance/i);
    expect(out.message).toMatch(/different instance|remove/i);
    expect(out.canForce).toBe(false);
  });

  it('falls back to the server message for an unknown code', () => {
    // This is what a future code hits.
    const err = new ApiError(409, { error: 'something new', code: 'not-a-real-code' }, 'something new');
    expect(syncErrorMessage(err).message).toBe('something new');
  });

  it('does not let a code of "constructor" fall through to Object.prototype', () => {
    // `'constructor' in SYNC_ERROR_COPY` is true (it's the Object
    // constructor), and `{...Object}` spreads to `{}` — a consumer would
    // render an empty error banner. `code` is `unknown` at this call site
    // (any caught value can carry it), so this must degrade to the server's
    // own message instead of returning a message-less object.
    const err = new ApiError(409, { error: 'boom', code: 'constructor' }, 'boom');
    const out = syncErrorMessage(err);
    expect(out.message).toBe('boom');
    expect(out.message.length).toBeGreaterThan(0);
  });

  it('falls back to the server message when there is no code at all', () => {
    // The LOCAL apply hierarchy (SyncApplyError) carries no `code`.
    const err = new ApiError(400, { error: 'a local apply failed' }, 'a local apply failed');
    expect(syncErrorMessage(err).message).toBe('a local apply failed');
  });

  it('surfaces collision counts when the local apply reports them', () => {
    const err = new ApiError(
      409,
      { error: 'collision', collisions: [{ collection: 'entries', count: 3 }] },
      'collision',
    );
    expect(syncErrorMessage(err).detail).toContain('entries');
    expect(syncErrorMessage(err).detail).toContain('3');
  });

  it('treats an empty collisions array as no detail, not an empty string', () => {
    const err = new ApiError(409, { error: 'collision', collisions: [] }, 'collision');
    expect(syncErrorMessage(err).detail).toBeUndefined();
  });

  it('drops a malformed collision element instead of rendering "undefined in undefined"', () => {
    // Array.isArray only narrows unknown to any[], so a parameter typed with
    // the "real" element shape would typecheck against a bad element with no
    // complaint. This is the case that lapse would let through silently.
    const err = new ApiError(
      409,
      { error: 'collision', collisions: [{ collection: 'entries', count: 3 }, { bogus: true }] },
      'collision',
    );
    const out = syncErrorMessage(err);
    expect(out.detail).toBe('3 in entries');
    expect(out.detail).not.toContain('undefined');
  });

  it('handles a non-ApiError throw with the generic fallback sentence', () => {
    expect(syncErrorMessage(new Error('boom')).message).toBe(
      'Something went wrong while talking to the server. Try again in a moment.',
    );
  });

  it("carries the throw site's own message as raw on the known-code path, for disclosure", () => {
    // e.g. remote-rejected's message embeds the remote's HTTP status
    // (402 vs 413 vs 409); blob-unavailable's embeds the hash count. Real,
    // code-specific information that must not be discarded by the copy map.
    const err = new ApiError(
      409,
      { error: 'The remote rejected the apply (HTTP 402)', code: 'remote-rejected' },
      'The remote rejected the apply (HTTP 402)',
    );
    expect(syncErrorMessage(err).raw).toBe('The remote rejected the apply (HTTP 402)');
  });
});

describe('lastErrorMessage', () => {
  it('explains a remote universe ownership collision without rejecting the PAT', () => {
    // Mutation caught: treating an ownership refusal like remote-unauthorized
    // sends the user to replace a valid credential instead of changing the
    // universe selection or removing test data.
    const out = lastErrorMessage(
      'remote-universe-forbidden: the universe identity is owned by another account on the remote',
    );
    expect(out?.message).toEqual(SYNC_ERROR_COPY['remote-universe-forbidden'].message);
    expect(out?.message).toMatch(/different universe, or remove the conflicting test data/i);
    expect(out?.message).toMatch(/Keep this token/i);
    expect(out?.message).not.toMatch(/Mint a new one|save it on the remote/i);
  });

  it('maps the `code: detail` shape to copy plus the detail', () => {
    const out = lastErrorMessage('remote-unauthorized: the stored PAT was rejected by the remote');
    expect(out!.message).toBe(SYNC_ERROR_COPY['remote-unauthorized'].message);
    expect(out!.detail).toBe('the stored PAT was rejected by the remote');
  });

  it('names the missing side for blob-unavailable, which is how the remedy reaches the UI', () => {
    // `side` is NOT on the wire. This string is the only path by which
    // "which side is missing" reaches the client.
    const out = lastErrorMessage('blob-unavailable: 3 asset blob(s) unavailable on both instances');
    expect(out!.detail).toContain('both instances');
  });

  it('renders the apply-error shape without pretending it is prose', () => {
    const out = lastErrorMessage('apply-error: ConstraintCollisionError');
    expect(out!.message).toContain('local apply');
    expect(out!.detail).toBe('ConstraintCollisionError');
  });

  it('renders the bare unexpected-error constant', () => {
    const out = lastErrorMessage('unexpected-error');
    expect(out!.message).toContain('unexpectedly');
  });

  it('does not let a head of "toString" fall through to Object.prototype', () => {
    // `'toString' in SYNC_ERROR_COPY` is true for the same reason
    // 'constructor' is — Object.prototype. Must degrade to the generic
    // fallback sentence, not a message-less object.
    const out = lastErrorMessage('toString: whatever');
    expect(out!.message.length).toBeGreaterThan(0);
  });

  it('always keeps the raw string available', () => {
    // The raw string is already scrubbed of row identity by design, and an
    // operator needs it. Every shape must expose it.
    for (const raw of [
      'remote-unreachable: POST /apply ECONNREFUSED',
      'apply-error: ConstraintCollisionError',
      'unexpected-error',
      'total gibberish that matches nothing',
    ]) {
      expect(lastErrorMessage(raw)!.raw).toBe(raw);
    }
  });

  it('returns null for no error', () => {
    expect(lastErrorMessage(null)).toBeNull();
  });
});

describe('SYNC_ERROR_COPY — message distinctness', () => {
  it('gives all 16 codes textually distinct prose', () => {
    // Not cosmetic. `combineRunError` originally decided "same failure?" by
    // comparing `message` strings, which is correct only while this holds.
    // Two entries edited to share prose would have let a stale error of one
    // code silently decorate a fresh failure of the other with the wrong
    // cause — and every existing test would have stayed green.
    //
    // The gate now compares codes, so this no longer guards correctness. It
    // guards the USER: two failures with different remedies must not read
    // identically on screen.
    const messages = Object.values(SYNC_ERROR_COPY).map((c) => c.message);
    expect(new Set(messages).size).toBe(16);
  });
});

describe('SyncCopy.code', () => {
  it('is set by syncErrorMessage for every known code', () => {
    for (const code of Object.keys(SYNC_ERROR_COPY)) {
      const out = syncErrorMessage(new ApiError(409, { error: 'x', code }, 'x'));
      expect(out.code).toBe(code);
    }
  });

  it('is set by lastErrorMessage for every known code', () => {
    for (const code of Object.keys(SYNC_ERROR_COPY)) {
      expect(lastErrorMessage(`${code}: some detail`)?.code).toBe(code);
    }
  });

  it('is absent wherever no code was established', () => {
    // Absent must mean "unknown", never "matches another absent" — the whole
    // reason `combineRunError` requires a code on both sides.
    expect(syncErrorMessage(new Error('network down')).code).toBeUndefined();
    expect(syncErrorMessage(new ApiError(400, { error: 'no code here' }, 'no code here')).code)
      .toBeUndefined();
    expect(lastErrorMessage('apply-error: CrossUniverseCollisionError')?.code).toBeUndefined();
    expect(lastErrorMessage('unexpected-error')?.code).toBeUndefined();
  });
});

describe('combineRunError', () => {
  const thrownBlob = () =>
    syncErrorMessage(
      new ApiError(
        409,
        { error: 'asset bytes unavailable', code: 'blob-unavailable' },
        'Asset bytes unavailable for 3 content hash(es)',
      ),
    );

  it('folds the column detail into a thrown error with the SAME code', () => {
    const { copy, unmergedPersisted } = combineRunError(
      thrownBlob(),
      'blob-unavailable: 3 asset blob(s) unavailable on this instance',
    );

    expect(copy.detail).toBe('3 asset blob(s) unavailable on this instance');
    // The thrown copy stays the base: `lastErrorMessage` sets neither of these,
    // and the count in `raw` is information the column does not carry.
    expect(copy.raw).toBe('Asset bytes unavailable for 3 content hash(es)');
    expect(copy.message).toBe(SYNC_ERROR_COPY['blob-unavailable'].message);
    // Already folded in — showing it again would repeat the same sentence.
    expect(unmergedPersisted).toBeNull();
  });

  it('keeps canForce when merging a busy failure', () => {
    const thrown = syncErrorMessage(new ApiError(409, { error: 'busy', code: 'busy' }, 'busy'));
    const { copy } = combineRunError(thrown, 'busy: claimed 4 minutes ago');

    // `lastErrorMessage` never sets canForce, so a merge that took the column
    // as its base would silently remove the "Run anyway" recovery path.
    expect(copy.canForce).toBe(true);
    expect(copy.detail).toBe('claimed 4 minutes ago');
  });

  it('returns the column SEPARATELY when the thrown error has no code', () => {
    // The likeliest failure of a multi-minute blocking request: the fetch dies
    // (proxy timeout, dropped connection). The thrown copy is the generic
    // sentence; the column holds the real diagnosis the server recorded, and
    // discarding it would leave the user with "something went wrong".
    const thrown = syncErrorMessage(new Error('Failed to fetch'));
    const { copy, unmergedPersisted } = combineRunError(
      thrown,
      'remote-quota-exceeded: remote reported 0 bytes free',
    );

    expect(copy).toEqual(thrown);
    expect(unmergedPersisted?.message).toBe(SYNC_ERROR_COPY['remote-quota-exceeded'].message);
    expect(unmergedPersisted?.detail).toBe('remote reported 0 bytes free');
  });

  it('returns the column separately when the two codes DIFFER', () => {
    const thrown = syncErrorMessage(new ApiError(409, { error: 'busy', code: 'busy' }, 'busy'));
    const { copy, unmergedPersisted } = combineRunError(
      thrown,
      'remote-unreachable: connect ECONNREFUSED 10.0.0.4:3001',
    );

    // No invented diagnosis: the fresh failure keeps its own copy…
    expect(copy.detail).toBeUndefined();
    expect(copy.message).toBe(SYNC_ERROR_COPY.busy.message);
    // …and the older one is handed back to be shown as its own separate thing.
    expect(unmergedPersisted?.message).toBe(SYNC_ERROR_COPY['remote-unreachable'].message);
  });

  it('hands back an apply-error column rather than dropping it', () => {
    // `SyncApplyError` carries no code on the wire, so an apply-error column
    // can never merge. This half of the return is how it still reaches a user.
    const thrown = syncErrorMessage(new Error('Failed to fetch'));
    const { unmergedPersisted } = combineRunError(
      thrown,
      'apply-error: CrossUniverseCollisionError',
    );

    expect(unmergedPersisted?.detail).toBe('CrossUniverseCollisionError');
  });

  it('does nothing when the column is empty', () => {
    const thrown = thrownBlob();
    expect(combineRunError(thrown, null)).toEqual({ copy: thrown, unmergedPersisted: null });
    expect(combineRunError(thrown, '')).toEqual({ copy: thrown, unmergedPersisted: null });
  });

  it('compares CODES, not prose', () => {
    // The gate has to survive two entries being given the same wording. Today
    // none share any (the distinctness test above enforces that), so a
    // message-equality gate is behaviourally identical and no test built from
    // the real producers can tell the two apart. Hand-building the thrown copy
    // is the only way to state which rule is actually intended.
    const thrown: SyncCopy = {
      message: SYNC_ERROR_COPY['remote-unreachable'].message,
      code: 'busy',
    };

    const { copy, unmergedPersisted } = combineRunError(
      thrown,
      'remote-unreachable: connect ECONNREFUSED 10.0.0.4:3001',
    );

    // Same prose, different failure: no merge, and the older one is handed back.
    expect(copy.detail).toBeUndefined();
    expect(unmergedPersisted?.detail).toBe('connect ECONNREFUSED 10.0.0.4:3001');
  });

  it('merges on a matching code even when the prose has diverged', () => {
    // The mirror image: a copy edit to SYNC_ERROR_COPY must not stop a column
    // merging with the failure it actually describes.
    const thrown: SyncCopy = { message: 'Some older wording for busy.', code: 'busy' };

    const { copy, unmergedPersisted } = combineRunError(thrown, 'busy: claimed 4 minutes ago');

    expect(copy.detail).toBe('claimed 4 minutes ago');
    expect(unmergedPersisted).toBeNull();
  });

  it('does not invent a detail when the column carries only a code', () => {
    const { copy, unmergedPersisted } = combineRunError(thrownBlob(), 'blob-unavailable');

    expect(copy.detail).toBeUndefined();
    expect(unmergedPersisted).toBeNull();
  });
});
