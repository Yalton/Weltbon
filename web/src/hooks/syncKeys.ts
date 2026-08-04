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
