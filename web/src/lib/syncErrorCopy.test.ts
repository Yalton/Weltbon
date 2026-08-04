import { describe, it, expect } from 'vitest';
import { syncErrorMessage, lastErrorMessage, SYNC_ERROR_COPY } from './syncErrorCopy';
import { ApiError } from '../api/client';

describe('syncErrorMessage', () => {
  it('maps every known code to copy that is not the code itself', () => {
    // Arming assertion: if a code is ever added to the map with its own id as
    // the copy, this catches it. Without this, a lazy entry passes silently.
    for (const [code, copy] of Object.entries(SYNC_ERROR_COPY)) {
      expect(copy.message).not.toBe(code);
      expect(copy.message.length).toBeGreaterThan(10);
    }
  });

  it('covers all 12 codes run-errors.ts declares', () => {
    // Pinned literally. A 13th code must fail this and force a copy decision
    // rather than silently falling back.
    expect(Object.keys(SYNC_ERROR_COPY).sort()).toEqual([
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
      'remote-universe-missing',
      'remote-unreachable',
    ]);
  });

  it('reads the code out of ApiError.body', () => {
    const err = new ApiError(409, { error: 'raw', code: 'busy' }, 'raw');
    expect(syncErrorMessage(err).message).toBe(SYNC_ERROR_COPY['busy'].message);
  });

  it('routes every one of the 12 codes through syncErrorMessage to written copy, not the bare code', () => {
    // The arming test above only inspects SYNC_ERROR_COPY directly — it never
    // calls syncErrorMessage, so a regression that hardcodes `message: code`
    // inside the function (rather than in the map) would pass it silently.
    // This walks the function itself for every known code.
    for (const code of Object.keys(SYNC_ERROR_COPY)) {
      const err = new ApiError(409, { error: 'raw', code }, 'raw');
      const out = syncErrorMessage(err);
      expect(out.message).not.toBe(code);
      expect(out.message).toBe(SYNC_ERROR_COPY[code].message);
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

  it('falls back to the server message for an unknown code', () => {
    // This is what a future 13th code hits.
    const err = new ApiError(409, { error: 'something new', code: 'not-a-real-code' }, 'something new');
    expect(syncErrorMessage(err).message).toBe('something new');
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

  it('handles a non-ApiError throw without crashing', () => {
    expect(syncErrorMessage(new Error('boom')).message.length).toBeGreaterThan(0);
  });

  it('carries the throw site\'s own message as raw on the known-code path, for disclosure', () => {
    // e.g. remote-rejected's message embeds the remote's HTTP status
    // (402 vs 413 vs 409); blob-unavailable's embeds the hash count. Real,
    // code-specific information that must not be discarded by the copy map.
    const err = new ApiError(409, { error: 'The remote rejected the apply (HTTP 402)', code: 'remote-rejected' }, 'The remote rejected the apply (HTTP 402)');
    expect(syncErrorMessage(err).raw).toBe('The remote rejected the apply (HTTP 402)');
  });
});

describe('lastErrorMessage', () => {
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
