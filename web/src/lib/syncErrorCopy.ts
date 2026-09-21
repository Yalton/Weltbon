import { ApiError } from '../api/client';

export interface SyncCopy {
  message: string;
  detail?: string;
  raw?: string;
  canForce?: boolean;
  code?: SyncErrorCode;
}

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

export const SYNC_ERROR_COPY: Record<SyncErrorCode, { message: string }> = {
  SELF_REMOTE: {
    message: 'This remote resolves to this Weltbon instance, so it cannot be linked or synced. Use the address and access token for a different instance, or remove the mistaken remote or link.',
  },
  'link-not-found': {
    // gone (run-errors.ts), OR `testRemote` throws the identical class when
    // the REMOTE row is missing (run-sync.ts:584) — surfaced by
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
    // (run-sync.ts:207,209 and the identical pair at :587,589): "encryption
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
    // must not promise a layout position for the missing-side detail — it
    message: 'Some asset files could not be transferred to complete the sync. One instance is missing their contents.',
  },
  'remote-rejected': {
    // Same surface-neutral treatment as blob-unavailable, and for the same
    // reason: what the remote objected to is `last_error`-only detail, not
    message: 'The remote instance rejected this sync.',
  },
  'universe-not-on-remote': {
    message: 'That universe is no longer on the remote instance. It may have been deleted there, or it may belong to a different account on that instance — refresh the list to see what is available there now.',
  },
  'universe-already-local': {
    message: 'You already have that universe on this instance. Adopting would replace its name and settings with the remote instance\'s copy — link it to the remote instead, which merges the two rather than overwriting yours.',
  },
};

function knownCode(code: string | undefined): SyncErrorCode | undefined {
  return code !== undefined && Object.hasOwn(SYNC_ERROR_COPY, code)
    ? (code as SyncErrorCode)
    : undefined;
}

function collisionDetail(items: unknown[]): string | undefined {
  const parts = items.flatMap((c) =>
    c && typeof c === 'object' && 'collection' in c && 'count' in c
      ? [`${String(c.count)} in ${String(c.collection)}`]
      : [],
  );
  return parts.length ? parts.join(', ') : undefined;
}

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
    return { ...SYNC_ERROR_COPY[known], code: known, raw: err.message, canForce: known === 'busy' };
  }

  // (a code added in run-errors.ts alone does NOT fail any test here — there
  const collisions =
    body && typeof body === 'object' && 'collisions' in body ? body.collisions : undefined;
  const detail = Array.isArray(collisions) ? collisionDetail(collisions) : undefined;

  return { message: err.message, detail, canForce: false };
}

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
  return {
    message: 'The sync failed unexpectedly. Try running it again; if it keeps happening, check the server logs.',
    raw,
  };
}

export function combineRunError(
  thrown: SyncCopy,
  lastError: string | null | undefined,
): { copy: SyncCopy; unmergedPersisted: SyncCopy | null } {
  const persisted = lastErrorMessage(lastError);
  if (!persisted) return { copy: thrown, unmergedPersisted: null };

  const sameFailure = !!thrown.code && persisted.code === thrown.code;
  if (!sameFailure) return { copy: thrown, unmergedPersisted: persisted };

  return {
    copy: persisted.detail ? { ...thrown, detail: persisted.detail } : thrown,
    unmergedPersisted: null,
  };
}
