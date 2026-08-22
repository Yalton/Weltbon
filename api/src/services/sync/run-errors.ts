/**
 * Plan D (D-08): one base class for every way a sync RUN can fail.
 *
 * This is C-19's lesson applied to the client side: a route that maps errors
 * with a per-class instanceof chain silently returns 500 the day a class is
 * added. Every subclass declares its own `code` (machine-readable, for Plan E's
 * UI) and `status`, so the route needs one branch and a new class that forgets
 * either is a compile error rather than a runtime surprise.
 *
 * D-09: `safeDetail` is what may be written to sync_links.last_error — a column
 * a future UI renders. It is built from OUR OWN fields, never from a remote
 * response body, because a peer's error body can embed that peer's row ids
 * (exactly the leak C-21 closed one layer in).
 */
import { SyncApplyError } from './errors.js';

/**
 * #44 (AS-08). What the auto-sync scheduler does with this failure.
 *
 *   'skip'  — not a failure at all. No backoff, no failure_count, never shown.
 *   'retry' — transient. Backoff grows; the link recovers on its own.
 *   'stop'  — a retry cannot fix it. Pause the link and show the remedy.
 *
 * Declared per subclass for the same reason `code` and `status` are (C-19): a
 * new class that has not thought about this must be a COMPILE error, not a
 * runtime surprise that silently inherits someone else's default.
 */
export type RetryPolicy = 'skip' | 'retry' | 'stop';

export abstract class SyncRunError extends Error {
  abstract readonly code: string;
  abstract readonly status: number;
  /** Operator-safe, never derived from a remote response body (D-09). */
  abstract readonly safeDetail: string;
  /** What the auto-sync scheduler does with this failure (AS-08). */
  abstract readonly retry: RetryPolicy;

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

export class SyncLinkNotFoundError extends SyncRunError {
  readonly code = 'link-not-found';
  readonly status = 404;
  readonly safeDetail = 'sync link does not exist';
  constructor() {
    super('Sync link not found');
  }
  get retry(): RetryPolicy { return 'stop'; } // nothing to sync
}

export class SyncLinkForbiddenError extends SyncRunError {
  readonly code = 'forbidden';
  readonly status = 403;
  readonly safeDetail = 'caller does not own this universe';
  constructor() {
    super('Forbidden');
  }
  get retry(): RetryPolicy { return 'stop'; } // ownership
}

export class SyncBusyError extends SyncRunError {
  readonly code = 'busy';
  readonly status = 409;
  readonly safeDetail = 'a sync is already running for this link';
  constructor() {
    super('A sync is already running for this link');
  }
  get retry(): RetryPolicy { return 'skip'; } // another run holds the lease
}

export class SyncRemoteKeyError extends SyncRunError {
  readonly code = 'remote-key-undecryptable';
  readonly status = 500;
  readonly safeDetail: string;
  constructor(reason: string) {
    super(`Cannot use the stored remote credential: ${reason}`);
    this.safeDetail = reason;
  }
  get retry(): RetryPolicy { return 'stop'; } // key undecryptable until re-entered
}

export class SyncUnreachableError extends SyncRunError {
  readonly code = 'remote-unreachable';
  readonly status = 502;
  readonly safeDetail: string;
  constructor(what: string, cause?: unknown) {
    // Native ES2022 Error.cause rather than a shadowing field of the same
    // name — same observable behavior, one less "why is this here".
    super(`Remote unreachable: ${what}`, { cause });
    // `what` is composed by the client from the METHOD and PATH it called plus
    // the transport error's name — never from a response body.
    this.safeDetail = what;
  }
  get retry(): RetryPolicy { return 'retry'; } // the offline laptop
}

export class SyncAuthError extends SyncRunError {
  readonly code = 'remote-unauthorized';
  readonly status = 401;
  readonly safeDetail = 'the stored PAT was rejected by the remote';
  constructor() {
    super('The remote rejected the stored PAT');
  }
  get retry(): RetryPolicy { return 'stop'; } // needs credentials
}

export class SyncRemoteOwnershipError extends SyncRunError {
  readonly code = 'remote-universe-forbidden';
  readonly status = 403;
  readonly safeDetail = 'the universe identity is owned by another account on the remote';

  constructor() {
    super('The remote refused access to this universe identity');
  }
  get retry(): RetryPolicy { return 'stop'; } // ownership
}

export class SyncPaymentError extends SyncRunError {
  readonly code = 'remote-payment-required';
  readonly status = 402;
  readonly safeDetail = 'the remote requires an active subscription (S-09)';
  constructor() {
    super('The remote requires an active subscription');
  }
  get retry(): RetryPolicy { return 'stop'; } // paid tier lapsed
}

export class SyncQuotaError extends SyncRunError {
  readonly code = 'remote-quota-exceeded';
  readonly status = 413;
  readonly safeDetail = 'the remote is out of storage quota (S-09)';
  constructor() {
    super('The remote is out of storage quota');
  }
  get retry(): RetryPolicy { return 'stop'; } // over quota until freed
}

export interface InstanceIdentityLike {
  instanceId: string;
  weltbonVersion: string;
  appVersion: string;
  migrationHead: string;
}

export class SyncSelfRemoteError extends SyncRunError {
  readonly code = 'SELF_REMOTE';
  readonly status = 409;
  readonly safeDetail = 'the configured remote is this Weltbon instance';
  constructor() {
    super('This remote resolves to this Weltbon instance and cannot be linked or synced');
  }
  get retry(): RetryPolicy { return 'stop'; } // adoption-path; unreachable from a run
}

export class SyncIncompatibleError extends SyncRunError {
  readonly code = 'remote-incompatible';
  readonly status = 409;
  readonly safeDetail: string;
  constructor(
    readonly local: InstanceIdentityLike,
    readonly remote: InstanceIdentityLike | null,
  ) {
    super('Instances are not compatible — update the older instance before syncing');
    // Safe to record NOT because these are inherently trustworthy — `remote`
    // is a peer's own 409 body and the peer controls it completely — but
    // because remote-client.ts's `sanitizeIdentity` validates every field
    // against a bounded pattern at the boundary before it ever reaches this
    // constructor, and substitutes null (rendered as `?` below) on failure.
    this.safeDetail =
      `local ${local.weltbonVersion}/${local.migrationHead} vs ` +
      `remote ${remote?.weltbonVersion ?? '?'}/${remote?.migrationHead ?? '?'}`;
  }
  get retry(): RetryPolicy { return 'stop'; } // needs an upgrade
}

/**
 * The apply engine returned fewer local upserts than the merge required.
 * Treat this as a failed run and leave the base unadvanced: reporting success
 * would strand the missing records behind a snapshot that says they synced.
 */
export class SyncLocalMaterializationError extends SyncRunError {
  readonly code = 'local-materialization-incomplete';
  readonly status = 500;
  readonly safeDetail = 'the local instance did not materialize every expected record';
  constructor(readonly collection: string, readonly expected: number, readonly applied: number) {
    super(`Local sync apply incomplete for ${collection}: expected ${expected}, applied ${applied}`);
  }
  get retry(): RetryPolicy { return 'retry'; } // base unadvanced so a re-run repairs
}

/**
 * D-07: the remote returned 404 for a universe we have a BASE for, meaning it
 * was deleted wholesale there. The spec makes this a link-severing event, never
 * a cascade delete of our copy — merging against an "empty" remote would read as
 * "remote deleted every row" and LWW would erase the local universe.
 */
export class SyncLinkSeveredError extends SyncRunError {
  readonly code = 'remote-universe-missing';
  readonly status = 409;
  readonly safeDetail = 'universe missing on remote — re-link or remove this link';
  constructor() {
    super('The universe no longer exists on the remote — re-link or remove this link');
  }
  get retry(): RetryPolicy { return 'stop'; } // already link-severing
}

/**
 * A-04: the peer does not hold the universe the caller asked to adopt.
 *
 * Distinct from SyncLinkSeveredError, which means an ESTABLISHED link's
 * universe vanished from the peer. This one means it was never there for this
 * credential — deleted, or owned by a different account on that instance.
 */
export class SyncUniverseNotOnRemoteError extends SyncRunError {
  readonly code = 'universe-not-on-remote';
  readonly status = 404;
  readonly safeDetail = 'the remote instance does not hold that universe';
  constructor() {
    super('That universe is not on the remote instance');
  }
  get retry(): RetryPolicy { return 'stop'; } // adoption-path
}

/**
 * A-07: adoption refuses a universe this instance already holds for this user.
 *
 * Adoption seeds the local universe from the REMOTE's row, so proceeding would
 * overwrite the local name, theme and settings with the peer's. The remedy is
 * the ordinary link route, which pairs two existing universes and merges them.
 */
export class SyncUniverseAlreadyLocalError extends SyncRunError {
  readonly code = 'universe-already-local';
  readonly status = 409;
  readonly safeDetail = 'this instance already holds that universe';
  constructor() {
    super('This instance already has that universe — link it instead of adopting it');
  }
  get retry(): RetryPolicy { return 'stop'; } // adoption-path
}

/** Which side of the link could not produce the bytes — see the class docstring. */
export type BlobUnavailableSide = 'local' | 'remote' | 'neither';

/**
 * D-09: `safeDetail` is what lands in sync_links.last_error, so it must name a
 * remedy and not just a symptom. `blob-unavailable` alone cannot: the three
 * producers of this error mean three different things with three different fixes.
 */
const SIDE_DETAIL: Record<BlobUnavailableSide, string> = {
  local: 'unavailable on this instance',
  remote: 'the remote no longer has',
  neither: 'unavailable on both instances',
};

/**
 * Blob bytes could not be sourced (C-12 race, D-11 — no auto-retry).
 *
 * `side` says BY WHOM, because the remedies diverge and a single string for all
 * three would tell an operator nothing actionable:
 *   - `local`   — we cannot source bytes we are supposed to own; re-upload the
 *                 file on this instance.
 *   - `remote`  — the peer 404'd bytes it had just told us it had; a race, so a
 *                 retry is the remedy.
 *   - `neither` — no copy exists on either instance; the asset is genuinely lost
 *                 and must be dropped or replaced.
 * Required, not optional (the C-19 lesson): a new throw site that has not thought
 * about which side it means must be a compile error, not a default.
 */
export class SyncBlobUnavailableError extends SyncRunError {
  readonly code = 'blob-unavailable';
  readonly status = 409;
  readonly safeDetail: string;
  constructor(
    readonly hashes: string[],
    readonly side: BlobUnavailableSide,
  ) {
    super(`Asset bytes unavailable for ${hashes.length} content hash(es)`);
    this.safeDetail = `${hashes.length} asset blob(s) ${SIDE_DETAIL[side]}`;
  }
  get retry(): RetryPolicy {
    // 'remote' is the C-12 race — the peer 404'd bytes it had just advertised.
    // 'local' and 'neither' need a human: re-upload, or accept the loss.
    return this.side === 'remote' ? 'retry' : 'stop';
  }
}

/**
 * What Plan C's apply route is contractually allowed to tell us. Anything else in
 * the body is DROPPED rather than trusted: Plan C sanitizes these two fields
 * deliberately (C-21), and nothing else in that body has a defined shape.
 */
export interface RemoteApplyDetail {
  missingAssetHashes?: string[];
  collisions?: Array<{ collection: string; count: number }>;
}

export class SyncApplyRejectedError extends SyncRunError {
  readonly code = 'remote-rejected';
  readonly status = 409;
  readonly safeDetail: string;
  constructor(
    readonly remoteStatus: number,
    readonly detail: RemoteApplyDetail,
  ) {
    super(`The remote rejected the apply (HTTP ${remoteStatus})`);
    const parts = [`remote apply returned ${remoteStatus}`];
    if (detail.missingAssetHashes?.length) parts.push(`${detail.missingAssetHashes.length} missing blob(s)`);
    if (detail.collisions?.length) {
      parts.push(detail.collisions.map((c) => `${c.collection}×${c.count}`).join(', '));
    }
    this.safeDetail = parts.join('; ');
  }
  get retry(): RetryPolicy { return 'stop'; } // identical delta, identical refusal
}

/**
 * The ONLY thing that may be written to sync_links.last_error (D-09).
 * An unrecognized throw is reduced to a constant — its message could be anything,
 * including a remote body someone concatenated in by accident.
 *
 * SyncApplyError (the LOCAL apply's own hierarchy — a separate class tree from
 * SyncRunError, thrown by applyManifestOps inside the drive loop) gets its own
 * branch here rather than falling into the 'unexpected-error' catch-all: an
 * operator staring at last_error deserves to know "a local apply constraint
 * collision" from "the remote was unreachable". Only the class NAME is used,
 * never `.message` — some subclasses' messages embed row ids from ANOTHER
 * universe (CrossUniverseCollisionError), exactly the C-21 leak this column
 * must not reintroduce. The class name alone (e.g. "ConstraintCollisionError")
 * is self-describing and carries no row identity.
 */
export function safeErrorSummary(err: unknown): string {
  if (err instanceof SyncRunError) return `${err.code}: ${err.safeDetail}`;
  if (err instanceof SyncApplyError) return `apply-error: ${err.name}`;
  return 'unexpected-error';
}
