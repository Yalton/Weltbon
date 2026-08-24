/**
 * Conventional-commit version computation (issue: desktop versioning).
 *
 * The module under test lives at the repo root (`scripts/next-version.mjs`)
 * because it is build infrastructure, not API code — the release workflow runs
 * it with bare `node` before anything is installed or compiled. Its test lives
 * here anyway: `api/`'s unit lane is the only always-on test runner in this
 * repo, and its `include` is a glob, so this file joins that lane with no
 * config change (see api/vitest.config.ts). A test that never runs is worse
 * than no test, and the root has no runner to run one.
 *
 * No DB, no network — do NOT add this file to DB_GATED_TESTS.
 */
import { describe, expect, test } from 'vitest';
import { computeBump, nextVersion, computeNextVersion, parseGitLog, GIT_LOG_FORMAT } from '../../scripts/next-version.mjs';

const c = (subject: string, body = '') => ({ subject, body });

describe('computeBump', () => {
  test('a feat commit is a minor bump', () => {
    expect(computeBump([c('feat(ingest): promote DOCX headings')])).toBe('minor');
  });

  test('a fix commit is a patch bump', () => {
    expect(computeBump([c('fix(api): type the yauzl v3 archive contract')])).toBe('patch');
  });

  test('a bang after the scope is a major bump', () => {
    expect(computeBump([c('feat(sync)!: replace the handshake payload')])).toBe('major');
  });

  test('a bang with no scope is a major bump', () => {
    expect(computeBump([c('refactor!: drop the v1 export format')])).toBe('major');
  });

  test('a BREAKING CHANGE footer is a major bump even on a plain fix', () => {
    expect(computeBump([
      c('fix(sync): reject manifests below 2.0.0', 'BREAKING CHANGE: older clients can no longer sync.'),
    ])).toBe('major');
  });

  test('release-irrelevant types alone produce no release', () => {
    expect(computeBump([
      c('docs(ingest): record the decisions'),
      c('chore: archive milestone files'),
      c('ci: run desktop tests'),
      c('test: cover the ordering fixture'),
      c('style: reformat'),
    ])).toBe(null);
  });

  test('no commits produce no release', () => {
    expect(computeBump([])).toBe(null);
  });

  test('the strongest bump in the range wins regardless of order', () => {
    expect(computeBump([c('fix: a'), c('feat: b'), c('docs: c')])).toBe('minor');
    expect(computeBump([c('feat: a'), c('fix!: b')])).toBe('major');
  });

  test('perf and refactor are patch bumps', () => {
    expect(computeBump([c('perf(graph): index the adjacency lookup')])).toBe('patch');
    expect(computeBump([c('refactor(sync): extract the schedule predicate')])).toBe('patch');
  });

  test('a non-conventional subject does not trigger a release on its own', () => {
    expect(computeBump([c('Merge pull request #78 from Citreum-LLC/feat/74')])).toBe(null);
  });

  test('BREAKING CHANGE must be a footer, not prose inside the body', () => {
    expect(computeBump([
      c('fix(sync): tolerate a missing cursor', 'This is not a BREAKING CHANGE, just a note.'),
    ])).toBe('patch');
  });
});

describe('nextVersion', () => {
  test('a minor bump zeroes the patch', () => {
    expect(nextVersion('1.4.7', 'minor')).toBe('1.5.0');
  });

  test('a major bump zeroes the minor and the patch', () => {
    expect(nextVersion('1.4.7', 'major')).toBe('2.0.0');
  });

  test('a patch bump increments only the patch', () => {
    expect(nextVersion('1.4.7', 'patch')).toBe('1.4.8');
  });

  /**
   * The 0.x rule, decided deliberately. Semver says anything may change while
   * the major is 0, and this project wants 1.0.0 to be a announced choice
   * rather than a side effect of the first `feat!:` someone writes. So a
   * breaking change below 1.0.0 bumps the minor instead of promoting.
   */
  test('a breaking change below 1.0.0 bumps the minor rather than promoting to 1.0.0', () => {
    expect(nextVersion('0.1.0', 'major')).toBe('0.2.0');
    expect(nextVersion('0.9.3', 'major')).toBe('0.10.0');
  });

  test('promotion to 1.0.0 is possible only by naming it explicitly', () => {
    expect(nextVersion('1.0.0', 'major')).toBe('2.0.0');
  });

  test('a version that is not three numeric parts is rejected', () => {
    expect(() => nextVersion('5.3', 'minor')).toThrow(/not a semver/i);
    expect(() => nextVersion('v1.2.3', 'minor')).toThrow(/not a semver/i);
    expect(() => nextVersion('1.2.3-dev.abc', 'minor')).toThrow(/not a semver/i);
  });

  test('an unknown bump kind is rejected rather than silently ignored', () => {
    // @ts-expect-error deliberately wrong, this is the guard being tested
    expect(() => nextVersion('1.2.3', 'huge')).toThrow(/unknown bump/i);
  });
});

describe('computeNextVersion', () => {
  test('returns null when nothing in the range warrants a release', () => {
    expect(computeNextVersion('0.1.0', [c('docs: only')])).toBe(null);
  });

  test('returns the computed version for a releasable range', () => {
    expect(computeNextVersion('0.1.0', [c('feat: a'), c('docs: b')])).toBe('0.2.0');
  });
});

/**
 * The release workflow feeds this function raw `git log` output. Bodies are
 * multi-line and this repo's commit convention REQUIRES a body, so a parser
 * that splits on newlines would mis-attribute every footer. The format string
 * lives next to the parser in scripts/next-version.mjs; these tests pin the
 * shape they agree on.
 */
describe('parseGitLog', () => {
  const REC = '\x1e';
  const SEP = '\x00';
  const rec = (subject: string, body = '') => `${subject}${SEP}${body}${REC}`;

  test('parses a single commit with an empty body', () => {
    expect(parseGitLog(rec('feat: a'))).toEqual([{ subject: 'feat: a', body: '' }]);
  });

  test('keeps a multi-line body intact so footers survive', () => {
    const body = 'Why this matters.\n\nBREAKING CHANGE: the wire format moved.';
    expect(parseGitLog(rec('fix(sync): reject old manifests', body))).toEqual([
      { subject: 'fix(sync): reject old manifests', body },
    ]);
  });

  test('parses several commits', () => {
    expect(parseGitLog(rec('feat: a', 'one') + rec('fix: b', 'two'))).toEqual([
      { subject: 'feat: a', body: 'one' },
      { subject: 'fix: b', body: 'two' },
    ]);
  });

  test('empty output is no commits, not one blank commit', () => {
    expect(parseGitLog('')).toEqual([]);
    expect(parseGitLog('\n')).toEqual([]);
  });

  test('a body containing the record separator would corrupt the parse, so it is rejected', () => {
    expect(() => parseGitLog(`only-a-subject-no-separator${REC}`)).toThrow(/malformed/i);
  });
});

describe('GIT_LOG_FORMAT', () => {
  /**
   * The separators must be git's OWN escapes (`%x00`, `%x1e`), not the raw
   * bytes. The format is passed to git through an argv array, and execve
   * strings are NUL-terminated — Node rejects a raw NUL in argv outright with
   * ERR_INVALID_ARG_VALUE. Building the format from real control bytes fails at
   * the spawn, before git ever runs.
   */
  test('carries git escapes rather than raw control bytes', () => {
    expect(GIT_LOG_FORMAT).toBe('%s%x00%b%x1e');
    expect(GIT_LOG_FORMAT).not.toContain('\x00');
    expect(GIT_LOG_FORMAT).not.toContain('\x1e');
  });
});
