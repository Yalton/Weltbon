#!/usr/bin/env node
/**
 * Advance Weltbon's deliberately simple release ladder.
 *
 * Every public release increments one visible decimal place:
 * 0.8.0 -> 0.9.0 -> 1.0.0 -> 1.1.0.  Releases have no patch releases and do
 * not depend on commit-message conventions.  Keeping this dependency-free lets
 * the Gitea release workflow calculate its tag before installing packages.
 */

/**
 * @param {string} current
 * @returns {string}
 */
export function nextReleaseVersion(current) {
  const match = /^(\d+)\.(\d+)\.0$/.exec(current);
  if (!match) {
    throw new Error(
      `"${current}" is not a release-ladder version — expected major.minor.0 with no prefix or pre-release suffix.`,
    );
  }

  const [major, minor] = match.slice(1).map(Number);
  return minor === 9 ? `${major + 1}.0.0` : `${major}.${minor + 1}.0`;
}

if (process.argv[1] && process.argv[1].endsWith('next-release-version.mjs')) {
  const current = process.argv[2];
  if (!current) {
    throw new Error('usage: next-release-version.mjs CURRENT_VERSION');
  }
  process.stdout.write(`${nextReleaseVersion(current)}\n`);
}
