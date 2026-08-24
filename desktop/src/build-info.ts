/**
 * Build identity handoff from packaging to the embedded API.
 *
 * WHY A FILE AND NOT esbuild --define. The obvious move is to substitute the
 * version into the API bundle at stage time. It does not work: api/src/version.ts
 * reads `process.env[key]` through a variable, and esbuild's `--define` only
 * replaces *statically written* `process.env.NAME` expressions. The substitution
 * would silently no-op and every packaged build would report the dev fallback —
 * exactly the class of failure this whole change exists to remove.
 *
 * So staging writes `version.json` beside the bundle, main.ts reads it here and
 * exports the values as real environment variables before importing the API,
 * alongside the DRIZZLE_DIR / WELTBON_FONT_DIR handoffs that already work this
 * way. The API keeps one mechanism (env) across hosted and desktop alike.
 *
 * Every failure mode returns null. This is decoration on a settings screen; it
 * must never be able to stop the app booting.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Written by desktop/scripts/stage-api.sh into the staged API root. */
export const BUILD_INFO_FILE = 'version.json';

export interface DesktopBuildInfo {
  version: string;
  commit: string | null;
  builtAt: string | null;
}

/**
 * Read `<apiRoot>/version.json`, or null when it is absent, unreadable,
 * malformed, or missing the one field that makes it meaningful.
 */
export function readBuildInfo(apiRoot: string): DesktopBuildInfo | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(join(apiRoot, BUILD_INFO_FILE), 'utf8'));
  } catch {
    // Absent (dev run, no staged tree) or corrupt. Same soft outcome either way.
    return null;
  }

  if (!parsed || typeof parsed !== 'object') return null;
  const { version, commit, builtAt } = parsed as Record<string, unknown>;

  // A build-info file that cannot name the version is corrupt, not partial.
  if (typeof version !== 'string' || version === '') return null;

  // Normalise absent to null, never undefined: the API serialises these
  // straight through, and an undefined would drop the key from the JSON
  // entirely — the web client branches on `commit === null`, not on presence.
  return {
    version,
    commit: typeof commit === 'string' && commit !== '' ? commit : null,
    builtAt: typeof builtAt === 'string' && builtAt !== '' ? builtAt : null,
  };
}

/**
 * Publish the build identity into the environment the embedded API reads.
 *
 * Call before importing the API entry — api/src/version.ts reads env live per
 * request, but the first request can arrive immediately after boot.
 */
export function exportBuildInfoEnv(apiRoot: string): DesktopBuildInfo | null {
  const info = readBuildInfo(apiRoot);
  if (!info) return null;

  process.env.WELTBON_VERSION = info.version;
  if (info.commit) process.env.WELTBON_COMMIT = info.commit;
  if (info.builtAt) process.env.WELTBON_BUILT_AT = info.builtAt;

  return info;
}
