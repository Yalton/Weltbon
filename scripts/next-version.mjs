#!/usr/bin/env node
/**
 * Compute the next release version from conventional commits.
 *
 * Used by .forgejo/workflows/release.yml. Plain `.mjs` with zero dependencies
 * and no build step on purpose: the release job runs this BEFORE `pnpm install`,
 * so anything requiring a compile or a node_modules tree would have to be
 * installed first just to answer "is there a release here at all?".
 *
 * WHY NOT release-please / semantic-release. Both do this better in the general
 * case. This repo decided against third-party release actions:
 * they need `contents: write`, and the release path is the
 * one place where a supply-chain compromise can push a tag and ship an image to
 * every self-hoster. The rules below are ~40 lines and fully tested; that is a
 * better trade here than granting write to another dependency.
 *
 * Exports are pure so api/tests/next-version.test.ts can exercise them without
 * a git repository. The CLI half at the bottom is the only part that shells out.
 */

/**
 * Types that produce a release, and the bump each one earns.
 *
 * Deliberately NOT exhaustive over conventional-commit types: `docs`, `chore`,
 * `ci`, `test`, and `style` are absent, which is what makes a docs-only merge
 * produce no tag. Adding a type here means every merge touching it starts
 * cutting releases, so add one only on purpose.
 */
const BUMP_BY_TYPE = {
  feat: 'minor',
  fix: 'patch',
  perf: 'patch',
  refactor: 'patch',
};

const RANK = { patch: 1, minor: 2, major: 3 };

/**
 * `type(optional scope)!: subject`. The `!` is the breaking marker and may sit
 * either directly after the type or after the scope; conventional commits
 * allows both spellings and this repo uses scopes on nearly every commit.
 */
const SUBJECT = /^([a-z]+)(?:\(([^)]*)\))?(!)?:\s/;

/**
 * A breaking-change footer must OWN its line. Matching the bare phrase anywhere
 * in the body would let a commit that merely mentions the words — "this is not
 * a BREAKING CHANGE" — silently cut a major release. Both the space and the
 * hyphen spellings are valid per the spec.
 */
const BREAKING_FOOTER = /^BREAKING[ -]CHANGE:\s/m;

/**
 * The strongest bump earned by any commit in the range, or null when none of
 * them warrants a release.
 *
 * @param {Array<{subject: string, body?: string}>} commits
 * @returns {'major'|'minor'|'patch'|null}
 */
export function computeBump(commits) {
  let best = null;

  for (const { subject, body = '' } of commits) {
    let bump = null;

    const m = SUBJECT.exec(subject);
    if (m) {
      const [, type, , bang] = m;
      // A `!` is breaking whatever the type is: `refactor!:` is still a break.
      bump = bang ? 'major' : (BUMP_BY_TYPE[type] ?? null);
    }

    // A footer promotes to major even on a type that would otherwise be a patch,
    // and even on a subject that parses as nothing at all.
    if (BREAKING_FOOTER.test(body)) bump = 'major';

    if (bump && (!best || RANK[bump] > RANK[best])) best = bump;
  }

  return best;
}

/**
 * Apply a bump to a version string.
 *
 * THE 0.x RULE. Below 1.0.0 a breaking change bumps the MINOR rather than
 * promoting to 1.0.0. Semver says anything may change while the major is 0, and
 * reaching 1.0.0 should be an announced decision about the app's stability —
 * not a side effect of whoever first writes `feat!:`. Promotion is done by
 * hand-editing the version once, after which this function behaves normally.
 *
 * @param {string} current
 * @param {'major'|'minor'|'patch'} bump
 * @returns {string}
 */
export function nextVersion(current, bump) {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(current);
  if (!m) {
    throw new Error(
      `"${current}" is not a semver version — expected three numeric parts, no "v" prefix and no pre-release suffix.`,
    );
  }

  const [major, minor, patch] = m.slice(1).map(Number);

  switch (bump) {
    case 'major':
      return major === 0 ? `0.${minor + 1}.0` : `${major + 1}.0.0`;
    case 'minor':
      return `${major}.${minor + 1}.0`;
    case 'patch':
      return `${major}.${minor}.${patch + 1}`;
    default:
      throw new Error(`unknown bump "${bump}" — expected major, minor or patch.`);
  }
}

/**
 * The version this range should be released as, or null for no release.
 *
 * @param {string} current
 * @param {Array<{subject: string, body?: string}>} commits
 * @returns {string|null}
 */
export function computeNextVersion(current, commits) {
  const bump = computeBump(commits);
  return bump ? nextVersion(current, bump) : null;
}

/**
 * Field and record separators for the `git log` format this module parses.
 *
 * NUL and RS rather than newlines because this repo REQUIRES a commit body that
 * explains why, and those bodies are multi-line with blank lines in them. A
 * newline-delimited format cannot tell a body's second paragraph from the next
 * commit's subject, which would mis-attribute every BREAKING CHANGE footer —
 * the one thing in this file that must never be read from the wrong commit.
 * Neither byte can occur in a git commit message.
 */
const SEP = '\x00';
const REC = '\x1e';

/**
 * The `--format` string that produces what parseGitLog expects.
 *
 * Built from git's OWN escapes rather than from SEP/REC directly. The format is
 * handed to git through an argv array, and execve strings are NUL-terminated —
 * Node rejects a raw NUL in argv with ERR_INVALID_ARG_VALUE before git is even
 * spawned. `%x00`/`%x1e` are expanded by git itself, on git's side of that
 * boundary, so the bytes only ever exist in the OUTPUT that parseGitLog reads.
 */
export const GIT_LOG_FORMAT = '%s%x00%b%x1e';

/**
 * Parse `git log --format=GIT_LOG_FORMAT` output into commit records.
 *
 * @param {string} stdout
 * @returns {Array<{subject: string, body: string}>}
 */
export function parseGitLog(stdout) {
  const commits = [];

  for (const raw of stdout.split(REC)) {
    // git separates records with a newline of its own; strip only the edges so
    // that blank lines INSIDE a body survive.
    const record = raw.replace(/^\n+/, '').replace(/\n+$/, '');
    if (record === '') continue;

    const parts = record.split(SEP);
    if (parts.length !== 2) {
      throw new Error(
        `malformed git log record (expected exactly one NUL separator, got ${parts.length - 1}): ${JSON.stringify(record.slice(0, 120))}`,
      );
    }

    commits.push({ subject: parts[0], body: parts[1] });
  }

  return commits;
}

// ── CLI ──────────────────────────────────────────────────────────────────────────
// Thin glue only: every decision above is pure and unit-tested. This half picks
// the range and prints the answer.
//
// execFileSync with an argv array, never execSync with a command string. The
// format separators are NUL and RS, and passing them through a shell mangles
// them — the first attempt used `execSync` with a JSON.stringify'd format and
// git received the six literal characters `\u0000` instead of a NUL byte, so
// every record parsed as malformed. An argv array has no quoting layer to get
// this wrong.

/**
 * The most recent RELEASE tag, or null if none exists yet.
 *
 * The pattern is strict three-part semver on purpose. This repo's `v1.0`-`v5.3`
 * tags are milestone archives from a different numbering scheme entirely
 * (`chore: archive v5.3 milestone files`), and matching them would compute the
 * next release against a version the app never had.
 */
function lastReleaseTag(git) {
  const out = git(['tag', '--list', 'v[0-9]*.[0-9]*.[0-9]*', '--sort=-v:refname']);
  const tags = out.split('\n').map((t) => t.trim()).filter((t) => /^v\d+\.\d+\.\d+$/.test(t));
  return tags.length ? tags[0] : null;
}

async function main() {
  const { execFileSync } = await import('node:child_process');
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const { dirname, join } = await import('node:path');

  const repo = dirname(dirname(fileURLToPath(import.meta.url)));
  const git = (args) =>
    execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

  const current = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8')).version;
  const tag = lastReleaseTag(git);

  // With no release tag yet, every commit in history is in range. That is
  // correct for the first release and harmless after it.
  const range = tag ? `${tag}..HEAD` : 'HEAD';
  const commits = parseGitLog(git(['log', range, `--format=${GIT_LOG_FORMAT}`]));

  const bump = computeBump(commits);
  const version = computeNextVersion(current, commits);

  // Two consumers: a human reading the job log, and GITHUB_OUTPUT.
  process.stderr.write(
    `[next-version] current=${current} since=${tag ?? '(no release tag)'} commits=${commits.length} `
    + `bump=${bump ?? 'none'} next=${version ?? '(no release)'}\n`,
  );
  process.stdout.write(`release=${version ? 'true' : 'false'}\nversion=${version ?? ''}\n`);
}

// Only run when invoked directly, so importing this module in a test does not
// shell out to git.
if (process.argv[1] && process.argv[1].endsWith('next-version.mjs')) {
  await main();
}
