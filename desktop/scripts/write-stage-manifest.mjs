// Write the staged package.json for the bundled API (issue #8).
//
// The staged tree holds one bundled file plus the handful of packages that
// cannot be bundled. Its manifest therefore declares ONLY those externals, and
// pins each to the version already installed in the repo rather than a semver
// range — the staged copies must match what the lockfile resolved and what CI
// tested, not whatever the registry serves at build time.
//
// `type: module` is required: the bundle is ESM, and main.ts reaches it through
// a dynamic import of the file path.
//
// Usage: node write-stage-manifest.mjs <repo> <stage> <pkg...>

import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, dirname } from 'node:path';

const [, , REPO, STAGE, ...externals] = process.argv;
if (!REPO || !STAGE || externals.length === 0) {
  console.error('usage: write-stage-manifest.mjs <repo> <stage> <pkg...>');
  process.exit(2);
}

// Resolve from the api package so we read the versions the API itself uses,
// which is what the bundle was built against.
const requireFromApi = createRequire(join(REPO, 'api', 'package.json'));

/**
 * A package's installed version.
 *
 * `require.resolve('<pkg>/package.json')` is the obvious way and fails for any
 * package whose `exports` map does not list `./package.json` — sharp, among
 * others. So fall back to resolving the package's entry point and walking up
 * until a manifest with the right name appears.
 */
function installedVersion(name) {
  try {
    return JSON.parse(readFileSync(requireFromApi.resolve(`${name}/package.json`), 'utf8')).version;
  } catch { /* exports map hides package.json — fall through */ }

  let dir = dirname(requireFromApi.resolve(name));
  for (let up = 0; up < 10; up++) {
    const candidate = join(dir, 'package.json');
    try {
      const pkg = JSON.parse(readFileSync(candidate, 'utf8'));
      if (pkg.name === name && pkg.version) return pkg.version;
    } catch { /* keep walking */ }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

const dependencies = {};
for (const name of externals) {
  const version = installedVersion(name);
  if (!version) {
    console.error(
      `[stage-manifest] FATAL: cannot resolve ${name} from api/. ` +
      `It is declared external but is not installed — the staged app would fail at runtime.`,
    );
    process.exit(1);
  }
  dependencies[name] = version;
}

const manifest = {
  name: 'weltbon-api-staged',
  version: JSON.parse(readFileSync(join(REPO, 'api', 'package.json'), 'utf8')).version,
  private: true,
  type: 'module',
  dependencies,
};

writeFileSync(join(STAGE, 'package.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(
  `[stage-manifest] ${Object.entries(dependencies).map(([n, v]) => `${n}@${v}`).join(', ')}`,
);
