import { SyncApplyError } from './errors.js';

export type RetryPolicy = 'skip' | 'retry' | 'stop';

export abstract class SyncRunError extends Error {
  abstract readonly code: string;
  abstract readonly status: number;
  abstract readonly safeDetail: string;
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
    super(`Remote unreachable: ${what}`, { cause });
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
    // because remote-client.ts's `sanitizeIdentity` validates every field
    this.safeDetail =
      `local ${local.weltbonVersion}/${local.migrationHead} vs ` +
      `remote ${remote?.weltbonVersion ?? '?'}/${remote?.migrationHead ?? '?'}`;
  }
  get retry(): RetryPolicy { return 'stop'; } // needs an upgrade
}

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
 * The pause reasons that saving a fresh PAT actually resolves (#66).
 *
 * AS-08 makes "re-entered credentials" one of the three user actions that
 * unpause a link, and the PATCH-remote route used to honour that by clearing
 * `paused_reason` for EVERY link on the remote. That resumed links paused for
 * reasons a credential cannot touch — a universe deleted on the peer, a lapsed
 * subscription, an apply the peer rejected — each of which then re-paused
 * itself on its next run, after a wasted sync and a spell of the UI claiming a
 * link was healthy when it was not.
 *
 * Membership test for anything added here: would pasting a NEW TOKEN, and
 * nothing else, make the next run succeed? `remote-unauthorized` (the token was
 * rejected) and `remote-key-undecryptable` (the stored token could not be
 * decrypted, and saving re-encrypts it with the current key) both pass. A
 * lapsed subscription or an exhausted quota does not — those are resolved on
 * the remote, and their links still have two working remedies in AS-08's other
 * two actions: a successful "Sync now", or the auto-sync toggle.
 */
export const TOKEN_FIXABLE_PAUSE_REASONS = [
  'remote-unauthorized',
  'remote-key-undecryptable',
] as const;

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

export class SyncUniverseAlreadyLocalError extends SyncRunError {
  readonly code = 'universe-already-local';
  readonly status = 409;
  readonly safeDetail = 'this instance already holds that universe';
  constructor() {
    super('This instance already has that universe — link it instead of adopting it');
  }
  get retry(): RetryPolicy { return 'stop'; } // adoption-path
}

export type BlobUnavailableSide = 'local' | 'remote' | 'neither';

const SIDE_DETAIL: Record<BlobUnavailableSide, string> = {
  local: 'unavailable on this instance',
  remote: 'the remote no longer has',
  neither: 'unavailable on both instances',
};

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

export function safeErrorSummary(err: unknown): string {
  if (err instanceof SyncRunError) return `${err.code}: ${err.safeDetail}`;
  if (err instanceof SyncApplyError) return `apply-error: ${err.name}`;
  return 'unexpected-error';
}
