// Uses node:test and node:assert because this package has no separate test-runner dependency.
// Build first (`tsc`), then run: node --test dist/*.test.js
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadOrCreateSecrets, secretsPath } from './secrets.js';

describe('loadOrCreateSecrets', () => {
  let dir: string;

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'weltbon-secrets-'));
  });

  after(async () => {
    // Restore permissions before recursive rm — an unreadable dir/file would
    // otherwise fail cleanup on some platforms.
    await chmod(dir, 0o700).catch(() => {});
    await rm(dir, { recursive: true, force: true });
  });

  test('missing file (ENOENT) mints fresh secrets, written mode 0600, no leftover .tmp-* file', async () => {
    const p = join(dir, 'fresh', 'secrets.json');
    const secrets = await loadOrCreateSecrets(p);
    assert.equal(secrets.jwtSecret.length, 64);
    assert.equal(secrets.llmKeyEncryptionKey.length, 64);
    assert.match(secrets.jwtSecret, /^[0-9a-f]{64}$/);
    assert.match(secrets.llmKeyEncryptionKey, /^[0-9a-f]{64}$/);

    const st = await stat(p);
    assert.equal(st.mode & 0o777, 0o600);

    // The atomic-write temp file must not survive a successful write.
    const entries = await readdir(join(dir, 'fresh'));
    assert.deepEqual(entries, ['secrets.json']);
  });

  test('existing valid file is reused unchanged, not regenerated', async () => {
    const p = join(dir, 'existing-valid', 'secrets.json');
    await mkdir(join(dir, 'existing-valid'), { recursive: true });
    const original = {
      jwtSecret: 'a'.repeat(64),
      llmKeyEncryptionKey: 'b'.repeat(64),
    };
    await writeFile(p, JSON.stringify(original), { mode: 0o600 });

    const first = await loadOrCreateSecrets(p);
    assert.deepEqual(first, original);

    // A second call must return the SAME values, not mint new ones.
    const second = await loadOrCreateSecrets(p);
    assert.deepEqual(second, original);
  });

  test('a present-but-unreadable file (EACCES) rethrows rather than silently regenerating', async (t) => {
    if (process.getuid && process.getuid() === 0) {
      t.skip('running as root — permission bits do not block root reads');
      return;
    }
    const p = join(dir, 'unreadable', 'secrets.json');
    await mkdir(join(dir, 'unreadable'), { recursive: true });
    await writeFile(p, JSON.stringify({ jwtSecret: 'x'.repeat(64), llmKeyEncryptionKey: 'y'.repeat(64) }));
    await chmod(p, 0o000);

    try {
      await assert.rejects(() => loadOrCreateSecrets(p));
      // Must NOT have been silently overwritten with fresh secrets while
      // still unreadable to us — the file's bytes are untouched.
      await chmod(p, 0o600);
      const raw = JSON.parse(await readFile(p, 'utf8'));
      assert.equal(raw.jwtSecret, 'x'.repeat(64));
      assert.equal(raw.llmKeyEncryptionKey, 'y'.repeat(64));
    } finally {
      await chmod(p, 0o600).catch(() => {});
    }
  });

  test('a malformed (half-written) file rethrows rather than silently regenerating', async () => {
    const p = join(dir, 'malformed', 'secrets.json');
    await mkdir(join(dir, 'malformed'), { recursive: true });
    await writeFile(p, '{"jwtSecret": "abc', { mode: 0o600 }); // truncated JSON

    await assert.rejects(() => loadOrCreateSecrets(p));

    // Untouched — still the same truncated bytes, not clobbered with fresh secrets.
    const raw = await readFile(p, 'utf8');
    assert.equal(raw, '{"jwtSecret": "abc');
  });

  // Valid JSON that parses fine but is missing a
  // key (hand-edited, or written by some other schema) is the same clobber
  // class as the unreadable/malformed cases above, even though it can't
  // arise from a crash mid-write the way a truncated file can.
  test('valid JSON missing a key rethrows (naming the file) rather than silently regenerating', async () => {
    const p = join(dir, 'missing-key', 'secrets.json');
    await mkdir(join(dir, 'missing-key'), { recursive: true });
    const partial = { jwtSecret: 'a'.repeat(64) }; // llmKeyEncryptionKey absent
    await writeFile(p, JSON.stringify(partial), { mode: 0o600 });

    await assert.rejects(() => loadOrCreateSecrets(p), (err: Error) => {
      assert.match(err.message, /llmKeyEncryptionKey/);
      assert.ok(err.message.includes(p), 'error message should name the file path');
      return true;
    });

    // Untouched — still exactly the partial object, not clobbered with fresh secrets.
    const raw = JSON.parse(await readFile(p, 'utf8'));
    assert.deepEqual(raw, partial);
  });
});

describe('secretsPath', () => {
  test('joins userData dir with secrets.json', () => {
    assert.equal(secretsPath('/foo/bar'), join('/foo/bar', 'secrets.json'));
  });
});
