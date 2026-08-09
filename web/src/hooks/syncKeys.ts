/**
 * Plan F — the single definition of every TanStack Query key the sync UI uses.
 *
 * WHY ITS OWN MODULE. These keys are shared across a scope boundary:
 * `useSyncRemotes` is account-scoped and `useSyncLinks` (Task 3) is
 * universe-scoped, but the remotes module must invalidate the links keys
 * because `sync_links.remote_id` cascades. If each module declared its own
 * keys, the two would be free to drift — and drift here is silent: a
 * mismatched key makes an invalidation match nothing, and the only symptom is
 * a Sync tab listing links the server already deleted. One module both sides
 * import is what makes a second, subtly different `syncLinksKey` impossible
 * rather than merely discouraged.
 */

/** The caller's registered remotes (account-scoped — no universe in the key). */
export const SYNC_REMOTES_QUERY_KEY = ['sync', 'remotes'] as const;

/**
 * PREFIX, not a full key — every universe's links share it. Passing this to
 * `invalidateQueries` matches all of them at once, which is what a remote
 * delete requires (see `useDeleteSyncRemote`).
 */
export const SYNC_LINKS_QUERY_PREFIX = ['sync', 'links'] as const;

/**
 * The full key for ONE universe's sync links. Task 3's link hooks must build
 * their key with this factory rather than writing an array literal, so the
 * prefix above provably matches them.
 */
export const syncLinksKey = (universeId: string) =>
  [...SYNC_LINKS_QUERY_PREFIX, universeId] as const;

/**
 * The full key for ONE universe's sync conflicts.
 *
 * Deliberately NOT built on `SYNC_LINKS_QUERY_PREFIX` even though both are
 * universe-scoped: `sync_conflicts` carries neither a `remote_id` nor a
 * `link_id`, only `universe_id`, so nothing about it cascades from deleting a
 * remote. Sharing the links prefix would make `useDeleteSyncRemote`'s
 * prefix-invalidation sweep conflicts too — a refetch that can never return
 * different rows. A run, on the other hand, changes both, and invalidates each
 * key by name (see `useRunSyncLink`).
 */
export const syncConflictsKey = (universeId: string) =>
  ['sync', 'conflicts', universeId] as const;

/**
 * The full key for ONE remote's universe listing (A-04).
 *
 * Remote-scoped, like SYNC_REMOTES_QUERY_KEY, but deliberately NOT built on it:
 * this list is a live call to the peer, while the remotes list is local rows.
 * Sharing the prefix would make every remote CRUD mutation re-dial every peer.
 */
export const remoteUniversesKey = (remoteId: string) =>
  ['sync', 'remote-universes', remoteId] as const;
