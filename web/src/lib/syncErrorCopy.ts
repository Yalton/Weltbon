/**
 * Plan F (Task 1): pure error-copy for the sync UI.
 *
 * Two error surfaces feed this module, and neither may be improved by
 * surfacing raw exception text — that text can embed row ids from a
 * DIFFERENT universe (the leak C-21 / D-09 closed at the API layer). This
 * module only ever renders values the API has already scrubbed:
 *
 * 1. A run failure's `code` (api/src/services/sync/run-errors.ts) — one of
 *    12 `SyncRunError` subclasses. A sibling hierarchy, `SyncApplyError`
 *    (the LOCAL apply's own errors), carries no `code` at all, and may
 *    instead carry `collisions: [{collection, count}]` — counts only, never
 *    the colliding row ids.
 *
 * 2. `sync_links.last_error`, written by `safeErrorSummary` in one of three
 *    shapes: `${code}: ${safeDetail}`, `apply-error: ${ClassName}`, or the
 *    bare constant `unexpected-error`. `unexpected-error` is deliberately
 *    NOT a key in `SYNC_ERROR_COPY` below — it is not a `SyncRunErrorCode`,
 *    it is `safeErrorSummary`'s catch-all for an unrecognized throw, and is
 *    handled directly in `lastErrorMessage`.
 */
import { ApiError } from '../api/client';

export interface SyncCopy {
  message: string;
  detail?: string;
  raw?: string;
  canForce?: boolean;
}

/** One entry per `SyncRunErrorCode` in run-errors.ts — 12, no more, no fewer. */
export const SYNC_ERROR_COPY: Record<string, { message: string }> = {
  'link-not-found': {
    // Two distinct throw sites share this code (run-errors.ts / run-sync.ts):
    // the sync link itself may be gone, OR `testRemote` throws the same
    // class when the REMOTE row it points to is missing (run-sync.ts:584,
    // surfaced by testRemoteRoute — Task 2's "Test connection" button). The
    // copy must not assert which one, or it lies on one of the two surfaces.
    message: 'The sync link or the remote connection it points to could not be found. It may have been deleted — refresh the list and set it up again if you still need it.',
  },
  forbidden: {
    message: 'You do not have access to this universe, so this sync link cannot run. Check which account you are signed in as.',
  },
  busy: {
    message: 'A sync is already running for this link. Wait for it to finish, or force another run if you are sure the previous one is stuck.',
  },
  'remote-key-undecryptable': {
    // Two causes, distinguished by `reason` in the throw site's own message
    // (run-errors.ts:59-61): "encryption key not configured" versus "could not
    // decrypt stored PAT". That string reaches the UI as `raw`, so the
    // disclosure already tells the user which one they hit — the headline can
    // stay short and confident instead of hedging across both.
    message: 'The saved access token for the remote connection could not be decrypted. Re-save the token on that remote connection; every link to it uses the same one.',
  },
  'remote-unreachable': {
    message: 'The remote instance could not be reached. Check that it is online and that its address is still correct, then try again.',
  },
  'remote-unauthorized': {
    message: 'The remote instance rejected the saved access token. Mint a new token on the remote instance and save it on the remote connection — every sync link to that remote will pick it up.',
  },
  'remote-payment-required': {
    message: 'The remote instance needs an active subscription before it will accept a sync. Resolve billing on that instance, then try again.',
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
    // `lastErrorMessage`'s blob-unavailable handling). Do not promise a
    // layout position ("below") for that detail: this copy is rendered by
    // both `syncErrorMessage` (immediate run failure) and `lastErrorMessage`
    // (persisted column), and Task 3 renders those in different regions.
    message: "Some file attachments could not be found to complete the sync. Check the link's last error for which side is missing them.",
  },
  'remote-rejected': {
    message: "The remote instance rejected this sync. Check the link's last error for what it objected to.",
  },
};

function collisionDetail(collisions: Array<{ collection: string; count: number }>): string {
  return collisions.map((c) => `${c.count} in ${c.collection}`).join(', ');
}

/** Copy for a value thrown by a sync API call (e.g. `POST /sync/links/:id/run`). */
export function syncErrorMessage(err: unknown): SyncCopy {
  if (!(err instanceof ApiError)) {
    return { message: 'Something went wrong while talking to the server. Try again in a moment.' };
  }

  const body = err.body;
  const code =
    body && typeof body === 'object' && 'code' in body ? String((body as Record<string, unknown>).code) : undefined;

  if (code && code in SYNC_ERROR_COPY) {
    // err.message is the throw site's own text (e.g. `remote-rejected`:
    // "The remote rejected the apply (HTTP 402)"; `blob-unavailable`: "Asset
    // bytes unavailable for 3 content hash(es)") — real, code-specific
    // information a disclosure can show, so it must not be discarded.
    return { ...SYNC_ERROR_COPY[code], raw: err.message, canForce: code === 'busy' };
  }

  // Unknown/absent code: either a 13th code the copy map has not caught up
  // to, or the LOCAL apply hierarchy (SyncApplyError), which never sets
  // `code`. Fall back to the server's own message rather than guessing.
  const collisions =
    body && typeof body === 'object' && 'collisions' in body
      ? (body as Record<string, unknown>).collisions
      : undefined;
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
      detail: rest,
      raw,
    };
  }

  if (head in SYNC_ERROR_COPY) {
    return { ...SYNC_ERROR_COPY[head], detail: rest, raw };
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
