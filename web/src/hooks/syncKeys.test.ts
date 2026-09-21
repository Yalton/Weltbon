import { describe, it, expect } from 'vitest';
import {
  SYNC_REMOTES_QUERY_KEY,
  SYNC_LINKS_QUERY_PREFIX,
  syncLinksKey,
  syncConflictsKey,
} from './syncKeys';

describe('syncKeys', () => {
  it('keys remotes without a universe — the row is account-scoped', () => {
    expect([...SYNC_REMOTES_QUERY_KEY]).toEqual(['sync', 'remotes']);
  });

  it('builds a links key that STARTS WITH the prefix the cascade invalidates', () => {
    // `useDeleteSyncRemote` invalidates the two-element prefix. That only
    // reaches a universe's links if the full key begins with it — this is the

    // instead of a literal at each call site.
    expect(syncLinksKey('u1').slice(0, 2)).toEqual([...SYNC_LINKS_QUERY_PREFIX]);
    expect(syncLinksKey('u1')).toEqual(['sync', 'links', 'u1']);
  });

  it('gives different universes different keys', () => {
    // Otherwise one universe's links would evict another's from the cache.
    expect(syncLinksKey('u1')).not.toEqual(syncLinksKey('u2'));
    expect(syncConflictsKey('u1')).not.toEqual(syncConflictsKey('u2'));
  });

  it('keys conflicts OUTSIDE the links prefix', () => {
    // `sync_conflicts` has no remote_id and no link_id, so a remote delete
    // cascades nothing into it. If this key began with ['sync','links'], the
    // account-scoped cascade in `useDeleteSyncRemote` would invalidate
    // conflicts as a side effect and refetch rows that cannot have changed.
    expect(syncConflictsKey('u1')).toEqual(['sync', 'conflicts', 'u1']);
    expect(syncConflictsKey('u1').slice(0, 2)).not.toEqual([...SYNC_LINKS_QUERY_PREFIX]);
  });
});
