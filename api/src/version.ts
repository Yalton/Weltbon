
function envOrNull(key: string): string | null {
  const v = process.env[key];
  return v && v.trim() !== '' ? v : null;
}

function packageVersion(): string {
  try {
    // a single low-traffic route, and a top-level await would make importing
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
  commit: string | null;
  builtAt: string | null;
}

export function buildInfo(): BuildInfo {
  return {
    version: envOrNull('WELTBON_VERSION') ?? packageVersion(),
    commit: envOrNull('WELTBON_COMMIT'),
    builtAt: envOrNull('WELTBON_BUILT_AT'),
  };
}
