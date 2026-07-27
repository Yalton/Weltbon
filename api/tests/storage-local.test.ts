/**
 * Plan F0 Task 1 — LocalStorageBackend atomicity (F0-03) and size() (F0-05).
 *
 * UNIT LANE. Touches a real temp directory, never a database. Do NOT add this
 * file to DB_GATED_TESTS in vitest.config.ts.
 *
 * The load-bearing test here is `preserves the prior value when a write fails
 * partway`. A put-then-read-back test passes under a plain writeFile and is
 * exactly the kind of coverage that cannot fail; this one dies under it,
 * because writeFile opens the destination with 'w' and truncates it before
 * writing any byte.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// vi.hoisted, not a bare `let`: vi.mock is hoisted above every import, and the
// factory runs when local.ts is first imported — which is also hoisted. A plain
// module-scope binding would be in its temporal dead zone at that moment.
const ctl = vi.hoisted(() => ({
  failNextWriteAfterBytes: -1,
  chunkWrites: false,
  chunkedWrites: 0,
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    writeFile: async (path: any, data: any, ...rest: any[]) => {
      if (ctl.failNextWriteAfterBytes >= 0) {
        const n = ctl.failNextWriteAfterBytes;
        ctl.failNextWriteAfterBytes = -1;
        // Simulate a crash mid-write: a PREFIX of the data lands, then the
        // process dies. Under a plain writeFile this prefix lands in the REAL
        // destination, which was already truncated at open.
        await actual.writeFile(path, (data as Buffer).subarray(0, n), ...rest);
        throw new Error('simulated crash mid-write');
      }
      if (ctl.chunkWrites) {
        // A single writeFile of a buffer this size lands in one write(2) on
        // this filesystem, so two concurrent unchunked writes do not actually
        // interleave — the concurrency test below would then pass even under a
        // shared temp path, pinning nothing. Splitting the write and yielding
        // between the halves makes the interleaving DETERMINISTIC rather than
        // filesystem-dependent, so the assertion pins the random suffix instead
        // of merely permitting it.
        ctl.chunkedWrites++;
        const buf = data as Buffer;
        const half = Math.floor(buf.length / 2);
        await actual.writeFile(path, buf.subarray(0, half), ...rest); // opens 'w' — truncates
        await new Promise((resolve) => setImmediate(resolve));
        await actual.appendFile(path, buf.subarray(half), ...rest);
        return;
      }
      return actual.writeFile(path, data, ...rest);
    },
  };
});

const { LocalStorageBackend } = await import('../src/services/storage/local.js');

describe('LocalStorageBackend', () => {
  let dir: string;
  let backend: InstanceType<typeof LocalStorageBackend>;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'weltbon-storage-'));
    backend = new LocalStorageBackend(dir);
    ctl.failNextWriteAfterBytes = -1;
    ctl.chunkWrites = false;
    ctl.chunkedWrites = 0;
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  describe('put atomicity (F0-03)', () => {
    it('preserves the prior value when a write fails partway', async () => {
      const OLD = Buffer.alloc(64 * 1024, 0xaa);
      const NEW = Buffer.alloc(64 * 1024, 0xbb);
      await backend.put('asset1', OLD);
      expect((await backend.get('asset1'))?.equals(OLD)).toBe(true);

      ctl.failNextWriteAfterBytes = 4;
      await expect(backend.put('asset1', NEW)).rejects.toThrow('simulated crash mid-write');

      // THE assertion. Under a plain writeFile the destination is truncated to
      // 4 bytes and this fails.
      const after = await backend.get('asset1');
      expect(after).not.toBeNull();
      expect(after!.length).toBe(OLD.length);
      expect(after!.equals(OLD)).toBe(true);
    });

    it('leaves no temp file behind when a write fails', async () => {
      await backend.put('asset2', Buffer.alloc(1024, 0x01));
      ctl.failNextWriteAfterBytes = 4;
      await expect(backend.put('asset2', Buffer.alloc(1024, 0x02))).rejects.toThrow();

      // Exactly the real key, nothing else. Catches a missing unlink-on-failure.
      expect((await readdir(dir)).sort()).toEqual(['asset2']);
    });

    it('leaves no temp file behind on success', async () => {
      await backend.put('asset3', Buffer.alloc(1024, 0x03));
      expect((await readdir(dir)).sort()).toEqual(['asset3']);
    });

    it('round-trips a key containing characters safeJoin strips', async () => {
      // safeJoin strips everything outside [a-zA-Z0-9_-], so 'a.b' addresses the
      // same file as 'ab'. That is pre-existing behavior; this pins that the
      // atomic rewrite did not change it, and that no temp file survives.
      const data = Buffer.alloc(512, 0x07);
      await backend.put('a.b', data);
      expect((await backend.get('a.b'))?.equals(data)).toBe(true);
      expect((await readdir(dir)).sort()).toEqual(['ab']);
    });

    it('never interleaves two concurrent puts of the same key', async () => {
      // chunkWrites splits each write and yields in between, so if both puts
      // shared one temp path they would provably corrupt each other: A
      // truncates and writes its first half, B truncates it away and writes
      // ITS first half, A appends its second half onto B's first — and the
      // rename then moves that mixture into place. A random temp suffix is the
      // only thing preventing it. Without the chunking this test passes under a
      // shared temp name too, and pins nothing.
      ctl.chunkWrites = true;
      try {
        const X = Buffer.alloc(256 * 1024, 0x11);
        const Y = Buffer.alloc(256 * 1024, 0x22);
        // allSettled, not all: under a shared temp path the loser's rename
        // ENOENTs because the winner already moved the temp file away, and a
        // rejection here would pre-empt the byte assertion below — leaving the
        // corruption itself unasserted and the test dependent on an error
        // escaping. Anyone later catching that rename would disarm it.
        const settled = await Promise.allSettled([backend.put('race', X), backend.put('race', Y)]);

        // The chunking is what makes the interleaving deterministic, so assert
        // it actually happened. Without this the test has no fail-loud
        // property: if put ever stops routing through the mocked writeFile,
        // chunkWrites silently becomes a no-op and this test passes while
        // pinning nothing.
        expect(ctl.chunkedWrites).toBe(2);

        // THE assertion: one WHOLE value, never a mixture. Under a shared temp
        // path the destination holds 384 KB in three alternating 128 KB runs —
        // one put's first half, then the other's second half, then the first
        // one's second half. Which of X and Y plays which role depends on the
        // scheduling of the two writes, so this asserts on wholeness rather
        // than on a fixed byte pattern. It fails on content, not on an
        // exception.
        const got = await backend.get('race');
        expect(got).not.toBeNull();
        expect(got!.equals(X) || got!.equals(Y)).toBe(true);

        // Secondary, and deliberately after the byte check: neither put should
        // have failed at all.
        expect(settled.map((s) => s.status)).toEqual(['fulfilled', 'fulfilled']);
      } finally {
        ctl.chunkWrites = false;
      }
    });
  });

  describe('size (F0-05)', () => {
    it('returns the byte length of a stored key', async () => {
      await backend.put('sized', Buffer.alloc(1234, 0x05));
      expect(await backend.size('sized')).toBe(1234);
    });

    it('returns null for a missing key rather than throwing', async () => {
      expect(await backend.size('does-not-exist')).toBeNull();
    });

    it('reports the size of the committed key, not of a temp file', async () => {
      await backend.put('sized2', Buffer.alloc(10, 0x06));
      await backend.put('sized2', Buffer.alloc(9999, 0x06));
      expect(await backend.size('sized2')).toBe(9999);
      // Earns the "not of a temp file" half of the name: size() never builds a
      // temp path, so the only way it could report one is if a temp file
      // survived. Assert none did.
      expect((await readdir(dir)).sort()).toEqual(['sized2']);
    });
  });
});
