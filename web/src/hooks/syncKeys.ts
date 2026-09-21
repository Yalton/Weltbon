
export const SYNC_REMOTES_QUERY_KEY = ['sync', 'remotes'] as const;

export const SYNC_LINKS_QUERY_PREFIX = ['sync', 'links'] as const;

export const syncLinksKey = (universeId: string) =>
  [...SYNC_LINKS_QUERY_PREFIX, universeId] as const;

export const syncConflictsKey = (universeId: string) =>
  ['sync', 'conflicts', universeId] as const;

export const remoteUniversesKey = (remoteId: string) =>
  ['sync', 'remote-universes', remoteId] as const;
