/**
 * Plan F (Task 1): pure error-copy for the sync UI.
 *
 * Two error surfaces feed this module, and neither may be improved by
 * surfacing raw exception text — that text can embed row ids from a
 * DIFFERENT universe (the leak C-21 / D-09 closed at the API layer). This
 * module only ever renders values the API has already scrubbed:
 *
 * 1. A run failure's `code` (api/src/services/sync/run-errors.ts) — one of
 *    12 `SyncRunError` subclasses, mirrored below as `SyncErrorCode`. A
 *    sibling hierarchy, `SyncApplyError` (the LOCAL apply's own errors),
 *    carries no `code` at all, and may instead carry
 *    `collisions: [{collection, count}]` — counts only, never the colliding
 *    row ids.
 *
 * 2. `sync_links.last_error`, written by `safeErrorSummary` in one of three
 *    shapes: `${code}: ${safeDetail}`, `apply-error: ${ClassName}`, or the
 *    bare constant `unexpected-error`. `unexpected-error` is deliberately
 *    NOT a key in `SYNC_ERROR_COPY` below — it is not a `SyncRunErrorCode`,
 *    it is `safeErrorSummary`'s catch-all for an unrecognized throw, and
 *    falls through to `lastErrorMessage`'s final fallback branch.
 *
 * Vocabulary: "remote" names the saved connection row a user manages at
 * `/settings/sync` (views/SyncSettings.tsx — same noun as "Sync remotes" /
 * "Add remote" there); "remote instance" names the peer server on the other
 * end of it. Keep the two distinct in every message below.
 */
import { ApiError } from '../api/client';

export interface SyncCopy {
  /** The headline sentence. Always present, always safe to render directly. */
  message: string;
  /**
   * A further specific fact to show under the headline: local-apply
   * collision counts (`syncErrorMessage`'s unknown-code fallback) or the
   * text after the code prefix in `sync_links.last_error`
   * (`lastErrorMessage`). Never set alongside `raw` on `syncErrorMessage`'s
   * known-code path — that path's specifics live in `raw` instead.
   */
  detail?: string;
  /**
   * The underlying machine text, for a "show details" disclosure. ITS SHAPE
   * DIFFERS BY CALLER: from `syncErrorMessage`'s known-code path it is only
   * the throw site's own message, disjoint from every other field; from
   * `lastErrorMessage` it is the WHOLE `last_error` column, with `detail`
   * already embedded verbatim inside it. A consumer that always renders
   * `message` + `detail` + `<details>{raw}</details>` will print the detail
   * twice on the `lastErrorMessage` path.
   */
  raw?: string;
  /** True only for `busy` — the caller may offer "Run anyway" (`?force=true`, F-02). */
  canForce?: boolean;
}

/** The 12 codes `run-errors.ts`'s `SyncRunError` subclasses declare. */
type SyncErrorCode =
  | 'link-not-found'
  | 'forbidden'
  | 'busy'
  | 'remote-key-undecryptable'
  | 'remote-unreachable'
  | 'remote-unauthorized'
  | 'remote-payment-required'
  | 'remote-quota-exceeded'
  | 'remote-incompatible'
  | 'remote-universe-missing'
  | 'blob-unavailable'
  | 'remote-rejected';

/** One entry per `SyncErrorCode` above — 12, no more, no fewer (enforced by the type). */
export const SYNC_ERROR_COPY: Record<SyncErrorCode, { message: string }> = {
  'link-not-found': {
    // Two distinct throw sites share this code: the sync link itself may be
    // gone (run-errors.ts), OR `testRemote` throws the identical class when
    // the REMOTE row is missing (run-sync.ts:584) — surfaced by
    // `/settings/sync`'s "Test connection" action (views/SyncSettings.tsx),
    // where no sync link is involved at all. The copy must not assert which
    // one, or it lies on one of the two surfaces.
    message: 'The sync link or the remote it points to could not be found. It may have been deleted — refresh the list and set it up again if you still need it.',
  },
  forbidden: {
    message: 'You do not have access to this universe, so this sync link cannot run. Check which account you are signed in as.',
  },
  busy: {
    message: 'A sync is already running for this sync link. Wait for it to finish, or force another run if you are sure the previous one is stuck.',
  },
  'remote-key-undecryptable': {
    // Two causes, distinguished by `reason` in the throw site's own message
    // (run-sync.ts:207,209 and the identical pair at :587,589): "encryption
    // key not configured" versus "could not decrypt stored PAT". That string
    // reaches the UI as `raw`, so the disclosure already tells the user
    // which one they hit — the headline can stay short.
    message: 'The saved access token for the remote could not be decrypted. Re-save the token on that remote; every sync link to it uses the same one.',
  },
  'remote-unreachable': {
    message: 'The remote instance could not be reached. Check that it is online and that its address is still correct, then try again.',
  },
  'remote-unauthorized': {
    message: 'The remote instance rejected the saved access token. Mint a new one there and save it on the remote — every sync link to it will pick it up.',
  },
  'remote-payment-required': {
    message: 'The remote instance needs an active subscription before it will accept a sync. Resolve billing there, then try again.',
  },
  'remote-quota-exceeded': {
    message: 'The remote instance is out of storage space, so it cannot accept this sync. Free up space there, or reduce what you are syncing.',
  },
  'remote-incompatible': {
    message: 'The two instances are running incompatible versions. Update the older instance so both are compatible, then try again.',
  },
  'remote-universe-missing': {
    message: 'The universe no longer exists on the remote instance. Re-link to a different universe there, or remove this sync link.',
  },
  'blob-unavailable': {
    // WHICH side is missing the bytes only reaches the client inside
    // `sync_links.last_error` (`side` is not on the wire — see
    // `lastErrorMessage`'s handling below). This copy is shared by
    // `syncErrorMessage` (an immediate run failure, rendered in
    // components/SyncTab.tsx) and `lastErrorMessage` (the persisted
    // `last_error`, rendered in a different region of that same tab), so it
    // must not promise a layout position for the missing-side detail — it
    // states the fact and leaves `detail` to supply specifics when present.
    message: 'Some asset files could not be transferred to complete the sync. One instance is missing their contents.',
  },
  'remote-rejected': {
    // Same surface-neutral treatment as blob-unavailable, and for the same
    // reason: what the remote objected to is `last_error`-only detail, not
    // part of this headline.
    message: 'The remote instance rejected this sync.',
  },
};

/**
 * `Object.hasOwn` rather than `in`: `in` also matches inherited
 * `Object.prototype` members ('constructor', 'toString', 'hasOwnProperty',
 * …), so `'constructor' in SYNC_ERROR_COPY` is true and
 * `SYNC_ERROR_COPY['constructor']` is the `Object` constructor — spreading
 * it produces `{}`, silently dropping `message` for a caller that passes
 * that string. Not reachable from today's server, but `syncErrorMessage`
 * advertises `(err: unknown)` and future callers (Tasks 2-4) will feed it
 * arbitrary caught values.
 */
function copyFor(code: string): { message: string } | undefined {
  return Object.hasOwn(SYNC_ERROR_COPY, code) ? SYNC_ERROR_COPY[code as SyncErrorCode] : undefined;
}

/**
 * `items` is deliberately `unknown[]`, not `Array<{collection, count}>`:
 * `Array.isArray` only narrows `unknown` to `any[]` at the call site, so a
 * parameter typed with the "real" shape would typecheck against a malformed
 * element with no complaint and render "undefined in undefined". Checking
 * each element's own shape here is what keeps that honest.
 */
function collisionDetail(items: unknown[]): string | undefined {
  const parts = items.flatMap((c) =>
    c && typeof c === 'object' && 'collection' in c && 'count' in c
      ? [`${String(c.count)} in ${String(c.collection)}`]
      : [],
  );
  return parts.length ? parts.join(', ') : undefined;
}

/** Copy for a value thrown by a sync API call (e.g. `POST /sync/links/:id/run`). */
export function syncErrorMessage(err: unknown): SyncCopy {
  if (!(err instanceof ApiError)) {
    return { message: 'Something went wrong while talking to the server. Try again in a moment.', canForce: false };
  }

  const body = err.body;
  const code =
    body && typeof body === 'object' && 'code' in body ? String(body.code) : undefined;
  const copy = code ? copyFor(code) : undefined;

  if (copy) {
    // err.message is the throw site's own text (e.g. `remote-rejected`:
    // "The remote rejected the apply (HTTP 402)"; `blob-unavailable`: "Asset
    // bytes unavailable for 3 content hash(es)") — real, code-specific
    // information a disclosure can show, so it must not be discarded.
    return { ...copy, raw: err.message, canForce: code === 'busy' };
  }

  // Unknown/absent code: either a 13th code this map has not caught up to
  // (a code added in run-errors.ts alone does NOT fail any test here — there
  // is no shared package and no web→api import — so it silently degrades to
  // this branch by design), or the LOCAL apply hierarchy (SyncApplyError),
  // which never sets `code`. Fall back to the server's own message.
  const collisions =
    body && typeof body === 'object' && 'collisions' in body ? body.collisions : undefined;
  const detail = Array.isArray(collisions) ? collisionDetail(collisions) : undefined;

  return { message: err.message, detail, canForce: false };
}

/** Copy for the `sync_links.last_error` column — see the module docstring for its 3 shapes. */
export function lastErrorMessage(raw: string | null | undefined): SyncCopy | null {
  if (!raw) return null;

  const sep = raw.indexOf(':');
  const head = sep === -1 ? raw : raw.slice(0, sep);
  const rest = sep === -1 ? undefined : raw.slice(sep + 1).trim();

  if (head === 'apply-error') {
    return {
      message: 'A local apply step failed while merging changes. See the detail below for which check failed.',
      detail: rest || undefined,
      raw,
    };
  }

  const copy = copyFor(head);
  if (copy) {
    return { ...copy, detail: rest || undefined, raw };
  }

  // Also covers the bare `unexpected-error` constant: it contains no `:`, so
  // `head` is the whole string, misses the map above, and falls through to
  // here — there is no separate branch for it because this is already the
  // right copy.
  return {
    message: 'The sync failed unexpectedly. Try running it again; if it keeps happening, check the server logs.',
    raw,
  };
}
