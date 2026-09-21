import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const BUILD_INFO_FILE = 'version.json';

export interface DesktopBuildInfo {
  version: string;
  commit: string | null;
  builtAt: string | null;
}

export function readBuildInfo(apiRoot: string): DesktopBuildInfo | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(join(apiRoot, BUILD_INFO_FILE), 'utf8'));
  } catch {
    return null;
  }

  if (!parsed || typeof parsed !== 'object') return null;
  const { version, commit, builtAt } = parsed as Record<string, unknown>;

  // A build-info file that cannot name the version is corrupt, not partial.
  if (typeof version !== 'string' || version === '') return null;

  return {
    version,
    commit: typeof commit === 'string' && commit !== '' ? commit : null,
    builtAt: typeof builtAt === 'string' && builtAt !== '' ? builtAt : null,
  };
}

export function exportBuildInfoEnv(apiRoot: string): DesktopBuildInfo | null {
  const info = readBuildInfo(apiRoot);
  if (!info) return null;

  process.env.WELTBON_VERSION = info.version;
  if (info.commit) process.env.WELTBON_COMMIT = info.commit;
  if (info.builtAt) process.env.WELTBON_BUILT_AT = info.builtAt;

  return info;
}
