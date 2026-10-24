
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const repoRoot = path.resolve(__dirname, '../..');
const forgejoReleasePath = path.join(repoRoot, '.forgejo', 'workflows', 'release.yml');
const forgejoRelease = fs.readFileSync(forgejoReleasePath, 'utf8');
const githubRelease = fs.readFileSync(path.join(repoRoot, '.github', 'workflows', 'release.yml'), 'utf8');
const composePath = path.join(repoRoot, 'docker-compose.yml');
const composeContent = fs.readFileSync(composePath, 'utf8');
const deployScriptPath = path.join(repoRoot, 'scripts', 'deploy.sh');

/**
 * The tag patterns under `on: push: tags:`.
 *
 * A line scanner rather than one regex. The regex version of this was wrong in
 * a way that mattered: it returned an empty list, and an empty list made the
 * "does not fire on milestone tags" assertion pass VACUOUSLY — `[].some(...)`
 * is false, so the test reported success while checking nothing at all. The
 * scanner is longer and obviously correct instead of short and quietly wrong.
 *
 * Deliberately not a YAML parse: `yaml` is not a declared dependency of api/,
 * and resolving it only works by walking up into the workspace root's store.
 * That works today and would break silently under a different pnpm layout — a
 * poor trade for reading four lines.
 */
function tagTriggerPatterns(yamlText: string): string[] {
  const lines = yamlText.split('\n');
  const patterns: string[] = [];

  let inPush = false;
  let inTags = false;

  for (const line of lines) {
    if (/^\s*#/.test(line) || line.trim() === '') continue;   // comments and blanks

    const indent = line.length - line.trimStart().length;

    if (/^\s*push:\s*$/.test(line)) { inPush = true; inTags = false; continue; }
    if (inPush && /^\s*tags:\s*$/.test(line)) { inTags = true; continue; }

    if (inTags) {
      const item = /^\s*-\s*['"]?([^'"#]+?)['"]?\s*$/.exec(line);
      if (item) { patterns.push(item[1]); continue; }
      // Any non-list, non-comment line ends the tags block.
      inTags = false;
      if (indent === 0) inPush = false;
    }
  }

  return patterns;
}

/**
 * Approximates GitHub's tag filter syntax closely enough for these assertions:
 * `*` is any run of non-`/` characters, `+` repeats the preceding element, a
 * bracket class is a character class, `?` is one character, and `.` is literal.
 *
 * Re-implementing a matcher inside a test is normally a smell. It earns its
 * place here because the alternative — asserting the pattern string verbatim —
 * is the exact brittleness that made this test go stale and then get merged red.
 */
function matchesTagPattern(pattern: string, tag: string): boolean {
  let re = '';
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === '[') {
      const close = pattern.indexOf(']', i);
      if (close === -1) { re += '\\['; continue; }
      re += pattern.slice(i, close + 1);
      i = close;
    } else if (ch === '*') re += '[^/]*';
    else if (ch === '+') re += '+';
    else if (ch === '?') re += '.';
    else re += ch.replace(/[.\\^$|()]/g, '\\$&');
  }
  return new RegExp(`^${re}$`).test(tag);
}

// ─────────────────────────────────────────────────────────────────────────────
// CONT-05: release image pipeline (built on Forgejo, copied to GHCR)
// ─────────────────────────────────────────────────────────────────────────────

describe('CONT-05 — release image pipeline (.forgejo/workflows/release.yml)', () => {
  it('builds on release tag pushes, including prereleases', () => {
    // Pinned exactly. Every assertion below reads this list, and an empty list
    // would make the negative assertions pass while checking nothing.
    expect(tagTriggerPatterns(forgejoRelease)).toEqual([
      'v[0-9]+.[0-9]+.[0-9]+',
      'v[0-9]+.[0-9]+.[0-9]+-*',
    ]);
  });

  it('covers three-part release tags and their prereleases', () => {
    const patterns = tagTriggerPatterns(forgejoRelease);
    for (const tag of ['v1.2.3', 'v0.2.1', 'v0.9.0-rc.1']) {
      expect(patterns.some((p) => matchesTagPattern(p, tag)), tag).toBe(true);
    }
  });

  it('does not fire on two-part milestone-archive tags', () => {
    const patterns = tagTriggerPatterns(forgejoRelease);
    expect(patterns.length).toBeGreaterThan(0);
    for (const milestone of ['v5.3', 'v1.0', 'v4.0']) {
      expect(
        patterns.some((p) => matchesTagPattern(p, milestone)),
        `A tag pattern in .forgejo/workflows/release.yml matches the milestone-archive tag ${milestone}. `
          + `Milestone tags are project-phase markers, not releases — publishing for `
          + `one moves \`latest\` to whatever the tree looked like at that moment. `
          + `Patterns found: ${JSON.stringify(patterns)}`,
      ).toBe(false);
    }
  });

  it('builds a linux/amd64 image with the version build args', () => {
    expect(forgejoRelease).toMatch(/--platform linux\/amd64/);
    for (const arg of ['WELTBON_VERSION', 'WELTBON_COMMIT', 'WELTBON_BUILT_AT']) {
      expect(forgejoRelease).toContain(`--build-arg ${arg}=`);
    }
  });

  it('moves `latest` only for full releases, never for a prerelease', () => {
    expect(forgejoRelease).toMatch(/if \[\[ "\$version" != \*-\* \]\]; then\n\s+tags\+=\(.*:latest"\)/);
    expect(githubRelease).toMatch(/\[\[ "\$version" != \*-\* \]\] && tags\+=\(.*latest\)/);
  });

  it('copies the image to GHCR with GITHUB_TOKEN rather than a long-lived PAT', () => {
    expect(githubRelease).toMatch(/packages:\s*write/);
    expect(githubRelease).toMatch(/GHCR_TOKEN:\s*\$\{\{\s*secrets\.GITHUB_TOKEN\s*\}\}/);
    expect(githubRelease).not.toMatch(/secrets\.(GHCR_PAT|CR_PAT)/);
  });

  it('docker-compose.yml has a commented image: switch for operators', () => {
    expect(composeContent).toMatch(/#\s*image:\s*ghcr\.io/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// OPS-07: api/package.json dev script auto-loads .env via tsx --env-file
// ─────────────────────────────────────────────────────────────────────────────

describe('OPS-07 — api/package.json dev script auto-loads .env', () => {
  const pkgPath = path.join(repoRoot, 'api', 'package.json');
  let pkg: { scripts?: Record<string, string> };

  it('api/package.json parses as valid JSON', () => {
    const raw = fs.readFileSync(pkgPath, 'utf8');
    expect(() => { pkg = JSON.parse(raw); }).not.toThrow();
  });

  it('dev script contains --env-file=../.env', () => {
    const raw = fs.readFileSync(pkgPath, 'utf8');
    pkg = JSON.parse(raw);
    expect(pkg.scripts?.dev).toMatch(/--env-file=\.\.\/\.env/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Build identity reaches a locally-built image
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A self-hosted deploy compiles from a clone — `docker compose build app` — so
 * the version and commit that GET /api/version reports have to come in as build
 * args. Nothing in the container can derive them: the git history is not copied
 * into the runtime stage, and the Dockerfile's ARGs default to empty.
 *
 * When this was missing, prod ran for a full release cycle reporting
 * `"commit": null`, which is precisely the "which build is this?" question the
 * endpoint exists to answer.
 */
describe('local builds stamp the build identity', () => {
  it('docker-compose.yml passes the three build args through to the Dockerfile', () => {
    for (const arg of ['WELTBON_VERSION', 'WELTBON_COMMIT', 'WELTBON_BUILT_AT']) {
      expect(
        composeContent,
        `docker-compose.yml does not pass ${arg} as a build arg, so a locally built `
          + `image cannot report it at GET /api/version.`,
      ).toMatch(new RegExp(`${arg}:\\s*\\$\\{${arg}`));
    }
  });

  it('ships a deploy script that derives those values', () => {
    expect(
      fs.existsSync(deployScriptPath),
      'scripts/deploy.sh is the documented way to compute the build identity; '
        + 'compose cannot shell out to git on its own.',
    ).toBe(true);
  });

  /**
   * `node` is not on PATH over a non-interactive ssh session on the deploy box
   * (nvm-style install). A deploy script reaching for `node -p` to read the
   * version fails with `command not found`, and because it sits in an `&&`
   * chain the whole deploy short-circuits while still looking like it ran.
   * That cost one silent no-op deploy.
   */
  it('the deploy script does not depend on node being on PATH', () => {
    // Comments stripped first: the script explains at length WHY it avoids
    // node, and a naive scan for the word flags that explanation as the very
    // thing it warns against.
    const executable = fs
      .readFileSync(deployScriptPath, 'utf8')
      .split('\n')
      .filter((line) => !/^\s*#/.test(line))
      .join('\n');

    expect(
      /(^|[|&;(`$\s])node\s/.test(executable),
      'scripts/deploy.sh invokes node. It runs over non-interactive ssh where node '
        + 'is not on PATH; derive the version with sed instead.',
    ).toBe(false);
  });
});
