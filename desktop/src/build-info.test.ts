// Tests for the packaged build's identity handoff.
//
// node:test / node:assert to match secrets.test.ts — this package has no test
// runner installed. Build first (`tsc`), then: node --test dist/*.test.js
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readBuildInfo, BUILD_INFO_FILE } from './build-info.js';

describe('readBuildInfo', () => {
  let dir: string;

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'weltbon-buildinfo-'));
  });

  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test('reads the three fields staging writes', async () => {
    await writeFile(
      join(dir, BUILD_INFO_FILE),
      JSON.stringify({ version: '0.2.0', commit: 'a1b2c3d', builtAt: '2026-08-24T00:00:00.000Z' }),
    );

    assert.deepEqual(readBuildInfo(dir), {
      version: '0.2.0',
      commit: 'a1b2c3d',
      builtAt: '2026-08-24T00:00:00.000Z',
    });
  });

  // A dev run boots the API straight from source with no staged tree, so this
  // file is absent by design. Throwing here would make `pnpm start` fail on a
  // missing decoration, which is a far worse outcome than an unknown version.
  test('returns null when the file is absent rather than throwing', async () => {
    const empty = await mkdtemp(join(tmpdir(), 'weltbon-buildinfo-empty-'));
    try {
      assert.equal(readBuildInfo(empty), null);
    } finally {
      await rm(empty, { recursive: true, force: true });
    }
  });

  // A truncated or half-written file must fail the same soft way as a missing
  // one. This is decoration; it must never be able to stop the app booting.
  test('returns null on malformed JSON rather than throwing', async () => {
    const bad = await mkdtemp(join(tmpdir(), 'weltbon-buildinfo-bad-'));
    try {
      await writeFile(join(bad, BUILD_INFO_FILE), '{ not json');
      assert.equal(readBuildInfo(bad), null);
    } finally {
      await rm(bad, { recursive: true, force: true });
    }
  });

  // The API treats an unknown commit as null. A file that omits the field must
  // produce that same null rather than `undefined`, which would serialize the
  // key away entirely and break the client's branch on it.
  test('normalises a missing commit to null rather than undefined', async () => {
    const partial = await mkdtemp(join(tmpdir(), 'weltbon-buildinfo-partial-'));
    try {
      await writeFile(join(partial, BUILD_INFO_FILE), JSON.stringify({ version: '0.2.0' }));
      const info = readBuildInfo(partial);
      assert.equal(info?.commit, null);
      assert.equal(info?.builtAt, null);
    } finally {
      await rm(partial, { recursive: true, force: true });
    }
  });

  // Without a version there is nothing to report, and a build-info file that
  // cannot name the version is corrupt rather than partial.
  test('rejects a file with no version at all', async () => {
    const noVersion = await mkdtemp(join(tmpdir(), 'weltbon-buildinfo-nov-'));
    try {
      await writeFile(join(noVersion, BUILD_INFO_FILE), JSON.stringify({ commit: 'a1b2c3d' }));
      assert.equal(readBuildInfo(noVersion), null);
    } finally {
      await rm(noVersion, { recursive: true, force: true });
    }
  });
});
