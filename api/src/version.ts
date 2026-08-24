/**
 * Build identity for the running instance.
 *
 * Three deployment shapes have to answer "which build is this?", and they get
 * the values in different ways:
 *
 *   hosted (docker)  ENV baked by the image build (see Dockerfile ARGs, set from
 *                    the release tag in publish-ghcr.yml)
 *   desktop          esbuild `--define` in desktop/scripts/stage-api.sh, which
 *                    substitutes the literals into the bundle at stage time
 *   dev (tsx)        neither is set, so it falls back to api/package.json
 *
 * WHY ENV RATHER THAN A GENERATED MODULE. A generated `version.generated.ts`
 * would be a build artifact living in `src/`, which means either committing a
 * file that is wrong on every branch or adding a codegen step ahead of `tsc`,
 * `tsx watch`, vitest and esbuild alike. Env costs one lookup and every one of
 * those already passes env through untouched.
 */

/** Read live, never captured at module scope — see the note in routes/config.ts. */
function envOrNull(key: string): string | null {
  const v = process.env[key];
  return v && v.trim() !== '' ? v : null;
}

/**
 * The version from api/package.json.
 *
 * Only reached in dev. In a bundled desktop build this file has been inlined
 * and `import.meta.url` points at the bundle, where `../package.json` is the
 * staged externals manifest rather than the app's — but that path is never
 * taken, because stage-api.sh bakes WELTBON_VERSION in. The try/catch is here
 * so that if it ever IS taken, the API still boots and reports something
 * honest instead of throwing at first request.
 */
function packageVersion(): string {
  try {
    // Deliberately synchronous and lazy: this runs at most once per request to
    // a single low-traffic route, and a top-level await would make importing
    // this module async for every consumer.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { readFileSync } = require('node:fs') as typeof import('node:fs');
    const url = new URL('../package.json', import.meta.url);
    const pkg = JSON.parse(readFileSync(url, 'utf8')) as { version?: unknown };
    return typeof pkg.version === 'string' ? pkg.version : 'unknown';
  } catch {
    return 'unknown';
  }
}

export interface BuildInfo {
  version: string;
  /** Short commit sha of the build, or null where none was baked in (dev). */
  commit: string | null;
  /** ISO-8601 build timestamp, or null where none was baked in (dev). */
  builtAt: string | null;
}

/**
 * What GET /api/version reports.
 *
 * `commit` and `builtAt` are null rather than absent when unknown: the settings
 * UI branches on them to decide whether to render the sha, and a client cannot
 * branch on a key that is sometimes missing.
 */
export function buildInfo(): BuildInfo {
  return {
    version: envOrNull('WELTBON_VERSION') ?? packageVersion(),
    commit: envOrNull('WELTBON_COMMIT'),
    builtAt: envOrNull('WELTBON_BUILT_AT'),
  };
}
