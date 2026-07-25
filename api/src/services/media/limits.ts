/**
 * Media size caps shared by every path that accepts or moves asset bytes:
 * the browser upload route (routes/assets.ts), the sync blob PUT/apply routes
 * (routes/sync.ts), the export→import round-trip (services/import-json.ts),
 * and the outbound sync client (services/sync/remote-client.ts) that caps how
 * many bytes it will read off a peer's GET response.
 *
 * Lives under services/media/, not routes/assets.ts, for the same reason
 * SHARP_OPTS moved here: services/sync/remote-client.ts is imported by Task
 * 7's in-process drive loop (services/sync/run-sync.ts), a NON-HTTP caller
 * that has no business transitively depending on @hono/zod-openapi,
 * hono/body-limit, file-type, and the rest of the asset CRUD route module
 * just to read a byte cap.
 *
 * D-10/WR-02: both caps are env-tunable and resolved LAZILY at call time
 * rather than captured as module-load constants. ES modules hoist `import`
 * above all other top-level code, so a consumer (e.g. a test) that sets
 * MEDIA_MAX_FILE_BYTES / MEDIA_UNIVERSE_QUOTA_BYTES before importing a module
 * that reads them still runs that assignment AFTER the module evaluates.
 * Reading lazily makes overrides set after module load take effect. This
 * laziness must be preserved by any future refactor of these two functions.
 *
 * Number() + isFinite guards a malformed env var (e.g. "10mb", or empty
 * string, both of which parseInt would silently turn into NaN) falling back
 * to the safe default instead of disabling the cap entirely.
 */
const DEFAULT_MAX_FILE_BYTES = 10 * 1024 * 1024;
const DEFAULT_MAX_UNIVERSE_QUOTA = 500 * 1024 * 1024;

export function maxFileBytes(): number {
  const n = Number(process.env.MEDIA_MAX_FILE_BYTES);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_MAX_FILE_BYTES;
}

export function maxUniverseQuota(): number {
  const n = Number(process.env.MEDIA_UNIVERSE_QUOTA_BYTES);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_MAX_UNIVERSE_QUOTA;
}
