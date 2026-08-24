/**
 * Types for next-version.mjs.
 *
 * The script itself stays plain JavaScript because the release workflow runs it
 * with bare `node` before anything is installed or compiled — a `.ts` source
 * would need a toolchain present just to answer "is there a release here?".
 * This declaration file gives the api's typecheck (and its test) real types
 * without putting a build step in front of the script.
 *
 * Keep in sync with the exports in next-version.mjs by hand. The pairing is
 * covered by api/tests/next-version.test.ts, which fails to compile if a name
 * or signature here stops matching what the script actually exports.
 */

export type Bump = 'major' | 'minor' | 'patch';

export interface CommitRecord {
  subject: string;
  body?: string;
}

/** The strongest bump earned by any commit, or null when none warrants a release. */
export function computeBump(commits: readonly CommitRecord[]): Bump | null;

/** Apply a bump. Throws on a non-semver input or an unknown bump kind. */
export function nextVersion(current: string, bump: Bump): string;

/** The version this range should be released as, or null for no release. */
export function computeNextVersion(current: string, commits: readonly CommitRecord[]): string | null;

/** The `git log --format=` string that produces what parseGitLog expects. */
export const GIT_LOG_FORMAT: string;

/** Parse `git log --format=GIT_LOG_FORMAT` output. Throws on a malformed record. */
export function parseGitLog(stdout: string): Array<{ subject: string; body: string }>;
