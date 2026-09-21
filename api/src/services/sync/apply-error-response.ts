import { UniverseOwnershipError, CrossUniverseCollisionError } from './apply.js';
import { SyncApplyError } from './errors.js';

export interface SyncApplyErrorResponse {
  body: {
    error: string;
    collisions?: Array<{ collection: string; count: number }>;
  };
  status: number;
}

export function mapSyncApplyError(err: SyncApplyError, caller: string): SyncApplyErrorResponse {
  if (err instanceof UniverseOwnershipError) {
    return { body: { error: 'Forbidden' }, status: 403 };
  }

  if (err instanceof CrossUniverseCollisionError) {
    // `collection[id, id]`), so it must NOT be echoed — the C-09 guard is
    // non-disclosure of other universes' row ids. Return only {collection,
    // count}; the ids are logged server-side for the operator.
    console.warn(`[${caller}] cross-universe collision:`, err.message);
    return {
      body: {
        error: 'Cross-universe id collision — some incoming ids already exist in another universe',
        collisions: err.collisions.map((col) => ({ collection: col.collection, count: col.ids.length })),
      },
      status: err.status,
    };
  }

  // Every other SyncApplyError is caller-fault and self-referential — safe to
  return { body: { error: err.message }, status: err.status };
}
