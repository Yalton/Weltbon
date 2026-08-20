/**
 * Plan F (Task 1): pure error-copy for the sync UI.
 *
 * Two error surfaces feed this module, and neither may be improved by
 * surfacing raw exception text — that text can embed row ids from a
 * DIFFERENT universe (the leak C-21 / D-09 closed at the API layer). This
 * module only ever renders values the API has already scrubbed:
 *
 * 1. A run failure's `code` (api/src/services/sync/run-errors.ts) — one of
 *    17 `SyncRunError` subclasses, mirrored below as `SyncErrorCode`. A
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
  /**
   * The machine code both producers recognised, when either did.
   *
   * Carried so consumers can ask "do these two copies describe the SAME
   * failure?" DIRECTLY. `combineRunError` below needs exactly that question
   * answered, and its first implementation asked it by comparing `message`
   * strings — sound only while all 17 messages stay distinct, which nothing
   * enforced. Two entries given the same prose would have made a stale error of
   * code A silently decorate a fresh failure of code B with A's cause.
   *
   * Absent on both fallback paths: `syncErrorMessage`'s unknown/absent-code
   * branch (including every `SyncApplyError`, which carries no code at all) and
   * `lastErrorMessage`'s `apply-error` and unexpected-error branches. Absent
   * means "no code was established", never "codes differ" — so a comparison
   * must require it to be present on BOTH sides before trusting equality.
   */
  code?: SyncErrorCode;
}

/** The 17 codes `run-errors.ts`'s `SyncRunError` subclasses declare. */
export type SyncErrorCode =
  | 'SELF_REMOTE'
  | 'link-not-found'
  | 'local-materialization-incomplete'
  | 'forbidden'
  | 'busy'
  | 'remote-key-undecryptable'
  | 'remote-unreachable'
  | 'remote-unauthorized'
  | 'remote-universe-forbidden'
  | 'remote-payment-required'
  | 'remote-quota-exceeded'
  | 'remote-incompatible'
  | 'remote-universe-missing'
  | 'blob-unavailable'
  | 'remote-rejected'
  | 'universe-not-on-remote'
  | 'universe-already-local';

/** One entry per `SyncErrorCode` above — 17, no more, no fewer (enforced by the type). */
export const SYNC_ERROR_COPY: Record<SyncErrorCode, { message: string }> = {
  SELF_REMOTE: {
    message: 'This remote resolves to this Weltbon instance, so it cannot be linked or synced. Use the address and access token for a different instance, or remove the mistaken remote or link.',
  },
  'link-not-found': {
    // Two distinct throw sites share this code: the sync link itself may be
    // gone (run-errors.ts), OR `testRemote` throws the identical class when
    // the REMOTE row is missing (run-sync.ts:584) — surfaced by
    // `/settings/sync`'s "Test connection" action (views/SyncSettings.tsx),
    // where no sync link is involved at all. The copy must not assert which
    // one, or it lies on one of the two surfaces.
    message: 'The sync link or the remote it points to could not be found. It may have been deleted — refresh the list and set it up again if you still need it.',
  },
  'local-materialization-incomplete': {
    message: 'This instance did not finish applying every record from the sync, so the run was not recorded as complete. Retry the sync; if it happens again, report the failure before making more changes.',
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
  'remote-universe-forbidden': {
    message: 'Universe identity conflict. Your access token is valid, but this universe identity already belongs to another account on the remote. Keep this token and sync a different universe, or remove the conflicting test data from the remote.',
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
  'universe-not-on-remote': {
    message: 'That universe is no longer on the remote instance. It may have been deleted there, or it may belong to a different account on that instance — refresh the list to see what is available there now.',
  },
  'universe-already-local': {
    message: 'You already have that universe on this instance. Adopting would replace its name and settings with the remote instance\'s copy — link it to the remote instead, which merges the two rather than overwriting yours.',
  },
};

/**
 * Narrow an arbitrary string to a code this map actually knows.
 *
 * `Object.hasOwn` rather than `in`: `in` also matches inherited
 * `Object.prototype` members ('constructor', 'toString', 'hasOwnProperty',
 * …), so `'constructor' in SYNC_ERROR_COPY` is true and
 * `SYNC_ERROR_COPY['constructor']` is the `Object` constructor — spreading
 * it produces `{}`, silently dropping `message` for a caller that passes
 * that string. Not reachable from today's server, but `syncErrorMessage`
 * advertises `(err: unknown)` and future callers (Tasks 2-4) will feed it
 * arbitrary caught values.
 */
function knownCode(code: string | undefined): SyncErrorCode | undefined {
  return code !== undefined && Object.hasOwn(SYNC_ERROR_COPY, code)
    ? (code as SyncErrorCode)
    : undefined;
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
  const known = knownCode(code);

  if (known) {
    // err.message is the throw site's own text (e.g. `remote-rejected`:
    // "The remote rejected the apply (HTTP 402)"; `blob-unavailable`: "Asset
    // bytes unavailable for 3 content hash(es)") — real, code-specific
    // information a disclosure can show, so it must not be discarded.
    return { ...SYNC_ERROR_COPY[known], code: known, raw: err.message, canForce: known === 'busy' };
  }

  // Unknown/absent code: either a future code this map has not caught up to
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

  const known = knownCode(head);
  if (known) {
    return { ...SYNC_ERROR_COPY[known], code: known, detail: rest || undefined, raw };
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

/**
 * Combine a just-thrown run error with the `sync_links.last_error` column the
 * same failure left behind.
 *
 * WHY THIS EXISTS AT ALL — it is the entire payoff of the run mutation
 * invalidating `onSettled` rather than `onSuccess`. `blob-unavailable`'s `side`
 * (WHICH instance is missing the bytes) is not on the wire: the route
 * serializes only `{error, code}`. So the thrown copy knows a COUNT
 * ("3 content hash(es)", in `raw`) and no remedy, while the column — written by
 * the server before the route returned — knows the remedy and no count. The
 * user needs both halves, so a refetch that is never rendered is a refetch
 * whose point was discarded.
 *
 * TWO OUTCOMES, because the two copies may or may not be about the same event:
 *
 *   - Same code → merge. The thrown copy stays the base so its `raw` and its
 *     `canForce` survive (`lastErrorMessage` sets neither), gaining the
 *     column's `detail`. `unmergedPersisted` is null: showing the column
 *     separately would repeat what the merged copy already says.
 *   - Different code, or no code on either side → NO merge, and the column is
 *     returned separately for the caller to render alongside. This is the
 *     commoner case and the one worth caring about: the likeliest failure of a
 *     multi-minute blocking request is the fetch itself dying (proxy timeout,
 *     dropped connection), which produces the generic non-`ApiError` sentence
 *     with no code — while the column holds the real diagnosis the server
 *     recorded. Suppressing it there would show the user "Something went wrong
 *     while talking to the server" and bin `remote-quota-exceeded`.
 *
 * The trade-off in returning an unmerged column: it may be an OLDER, unrelated
 * failure rather than this one's. That is the same staleness the caller already
 * accepts when it renders the column on a link nobody has run this session, so
 * it adds no risk that was not already taken — and an unrelated real diagnosis
 * beats a generic one and nothing.
 *
 * The gate is code equality, NOT message equality. Message equality is sound
 * only while all 14 entries stay textually distinct, which nothing enforces; a
 * copy edit that gave two entries the same prose would silently let a stale
 * error of code A decorate a fresh failure of code B with A's cause. Requiring
 * a code on BOTH sides also keeps `undefined === undefined` from reading as a
 * match between two copies that merely both failed to establish one.
 *
 * NOTE ON `apply-error`: a column written by the LOCAL apply hierarchy can
 * never merge, because `SyncApplyError` carries no code on the wire and so the
 * thrown copy never has one to match. Such a column reaches the user through
 * `unmergedPersisted` instead — which is precisely why that half exists.
 */
export function combineRunError(
  thrown: SyncCopy,
  lastError: string | null | undefined,
): { copy: SyncCopy; unmergedPersisted: SyncCopy | null } {
  const persisted = lastErrorMessage(lastError);
  if (!persisted) return { copy: thrown, unmergedPersisted: null };

  const sameFailure = !!thrown.code && persisted.code === thrown.code;
  if (!sameFailure) return { copy: thrown, unmergedPersisted: persisted };

  // Same failure: fold the column's detail in, and do not show it twice.
  return {
    copy: persisted.detail ? { ...thrown, detail: persisted.detail } : thrown,
    unmergedPersisted: null,
  };
}
