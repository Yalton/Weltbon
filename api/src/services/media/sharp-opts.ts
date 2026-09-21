/**
 * The pixel-bomb guard for every sharp() call that decodes bytes this instance
 * did not generate itself: browser uploads (routes/assets.ts), import-json
 * re-derivation (services/import-json.ts), and sync materialization
 * (services/sync/materialize.ts) — a peer's blob is no more trusted than a
 * browser upload or an imported export.
 *
 * `limitInputPixels` caps decoded pixel count and `failOn: 'truncated'` aborts
 * on truncated/corrupt pixel data, defusing decompression/pixel bombs
 * (T-38-12, D-11). Lives under services/media/, not routes/assets.ts, so a
 * @hono/zod-openapi, hono/body-limit, file-type, and the whole asset CRUD
 * surface to obtain one object literal. This used to be copy-pasted into
 * import-json.ts too — two copies of a security-relevant limit that must
 * never diverge was the actual defect.
 */
export const SHARP_OPTS = { limitInputPixels: 25_000_000, failOn: 'truncated' as const };
