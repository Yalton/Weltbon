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

export abstract class SyncRunError extends Error {
  abstract readonly code: string;
  abstract readonly status: number;
  /** Operator-safe, never derived from a remote response body (D-09). */
  abstract readonly safeDetail: string;

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
}

export class SyncLinkForbiddenError extends SyncRunError {
  readonly code = 'forbidden';
  readonly status = 403;
  readonly safeDetail = 'caller does not own this universe';
  constructor() {
    super('Forbidden');
  }
}

export class SyncBusyError extends SyncRunError {
  readonly code = 'busy';
  readonly status = 409;
  readonly safeDetail = 'a sync is already running for this link';
  constructor() {
    super('A sync is already running for this link');
  }
}

export class SyncRemoteKeyError extends SyncRunError {
  readonly code = 'remote-key-undecryptable';
  readonly status = 500;
  readonly safeDetail: string;
  constructor(reason: string) {
    super(`Cannot use the stored remote credential: ${reason}`);
    this.safeDetail = reason;
  }
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
}

export class SyncAuthError extends SyncRunError {
  readonly code = 'remote-unauthorized';
  readonly status = 401;
  readonly safeDetail = 'the stored PAT was rejected by the remote';
  constructor() {
    super('The remote rejected the stored PAT');
  }
}

export class SyncPaymentError extends SyncRunError {
  readonly code = 'remote-payment-required';
  readonly status = 402;
  readonly safeDetail = 'the remote requires an active subscription (S-09)';
  constructor() {
    super('The remote requires an active subscription');
  }
}

export class SyncQuotaError extends SyncRunError {
  readonly code = 'remote-quota-exceeded';
  readonly status = 413;
  readonly safeDetail = 'the remote is out of storage quota (S-09)';
  constructor() {
    super('The remote is out of storage quota');
  }
}

export interface InstanceIdentityLike {
  weltbonVersion: string;
  appVersion: string;
  migrationHead: string;
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
}

/** Blob bytes could not be sourced locally or from the peer (C-12 race, D-11). */
export class SyncBlobUnavailableError extends SyncRunError {
  readonly code = 'blob-unavailable';
  readonly status = 409;
  readonly safeDetail: string;
  constructor(readonly hashes: string[]) {
    super(`Asset bytes unavailable for ${hashes.length} content hash(es)`);
    this.safeDetail = `${hashes.length} asset blob(s) unavailable`;
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
