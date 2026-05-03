/**
 * Phase 11-03 Task 1 — ingest-zip streaming unpacker tests (TDD RED → GREEN).
 *
 * Coverage:
 *   - happy path (valid-vault.zip → all .md entries returned)
 *   - file_count cap (D-15 → BatchLimitError{limit:'file_count'})
 *   - file_size cap (D-15 → BatchLimitError{limit:'file_size'})
 *   - total_uncompressed_size cap (D-15b → BatchLimitError aborts mid-stream on bomb)
 *   - directory entries skipped
 *   - non-utf8/binary entries returned as best-effort string (endpoint filters non-md)
 *
 * Fixtures (re-built on demand if missing):
 *   - api/tests/fixtures/ingest/zip/valid-vault.zip
 *   - api/tests/fixtures/ingest/zip/zip-bomb.zip
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { unpackZip, BatchLimitError } from '../src/services/ingest-zip.js';
import yazl from 'yazl';

interface ZipFileLike {
  addBuffer(buffer: Buffer, metadataPath: string): void;
  addEmptyDirectory(metadataPath: string): void;
  end(): void;
  outputStream: NodeJS.ReadableStream;
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const FIXTURE_DIR = join(__dirname, 'fixtures', 'ingest', 'zip');
const VALID_VAULT_ZIP = join(FIXTURE_DIR, 'valid-vault.zip');
const ZIP_BOMB_ZIP = join(FIXTURE_DIR, 'zip-bomb.zip');
const VAULT_BASIC = join(__dirname, 'fixtures', 'ingest', 'vault-basic');
const BUILD_SCRIPT = join(FIXTURE_DIR, 'build-zips.ts');

function ensureFixtures(): void {
  if (existsSync(VALID_VAULT_ZIP) && existsSync(ZIP_BOMB_ZIP)) return;
  // Run the build script via tsx to materialise the fixtures.
  const tsxBin = join(__dirname, '..', 'node_modules', '.bin', 'tsx');
  const result = spawnSync(tsxBin, [BUILD_SCRIPT], { stdio: 'inherit' });
  if (result.status !== 0) {
    throw new Error(`build-zips.ts failed (exit ${result.status})`);
  }
}

function countMdFiles(root: string): number {
  let n = 0;
  function walk(dir: string): void {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, ent.name);
      if (ent.isDirectory()) walk(abs);
      else if (ent.isFile() && ent.name.toLowerCase().endsWith('.md')) n++;
    }
  }
  walk(root);
  return n;
}

async function makeZipBuffer(builder: (zip: ZipFileLike) => void): Promise<Buffer> {
  const zip = new yazl.ZipFile() as unknown as ZipFileLike;
  builder(zip);
  zip.end();
  return await new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    zip.outputStream.on('data', (chunk: Buffer) => chunks.push(chunk));
    zip.outputStream.on('end', () => resolve(Buffer.concat(chunks)));
    zip.outputStream.on('error', reject);
  });
}

describe('unpackZip (Phase 11-03 Task 1)', () => {
  beforeAll(() => {
    ensureFixtures();
  });

  it('happy path: unpacks valid-vault.zip and returns one entry per file under vault-basic/', async () => {
    const buf = readFileSync(VALID_VAULT_ZIP);
    const out = await unpackZip(buf, {
      maxFiles: 1000,
      maxFileSize: 1 * 1024 * 1024,
      maxTotalUncompressed: 100 * 1024 * 1024,
    });
    // Vault-basic contains .md + non-md (.png) + hidden-dir entries; unpacker
    // returns ALL non-directory entries (caller filters hidden + non-md).
    const mdCount = countMdFiles(VAULT_BASIC);
    expect(out.filter((e) => e.path.toLowerCase().endsWith('.md')).length).toBe(mdCount);
    // No entries should end with '/' (directories filtered out).
    expect(out.every((e) => !e.path.endsWith('/'))).toBe(true);
    // Paths should be forward-slash (POSIX) regardless of host OS.
    expect(out.every((e) => !e.path.includes('\\'))).toBe(true);
    // At least one body should contain expected vault content.
    const aragorn = out.find((e) => e.path.endsWith('aragorn.md'));
    expect(aragorn).toBeTruthy();
    expect(aragorn!.content).toContain('Aragorn');
  });

  it('file_count cap: rejects with BatchLimitError{file_count} when entries exceed maxFiles', async () => {
    const buf = readFileSync(VALID_VAULT_ZIP);
    let err: unknown;
    try {
      await unpackZip(buf, {
        maxFiles: 2,
        maxFileSize: 1 * 1024 * 1024,
        maxTotalUncompressed: 100 * 1024 * 1024,
      });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(BatchLimitError);
    expect((err as BatchLimitError).limit).toBe('file_count');
    expect((err as BatchLimitError).max).toBe(2);
  });

  it('file_size cap: rejects with BatchLimitError{file_size} when an entry exceeds maxFileSize', async () => {
    const buf = readFileSync(VALID_VAULT_ZIP);
    let err: unknown;
    try {
      await unpackZip(buf, {
        maxFiles: 1000,
        maxFileSize: 10, // every real .md is bigger than 10 bytes
        maxTotalUncompressed: 100 * 1024 * 1024,
      });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(BatchLimitError);
    expect((err as BatchLimitError).limit).toBe('file_size');
    expect((err as BatchLimitError).max).toBe(10);
  });

  it('total_uncompressed_size cap: rejects with BatchLimitError{total_uncompressed_size} on zip-bomb fixture', async () => {
    const buf = readFileSync(ZIP_BOMB_ZIP);
    // Sanity: the compressed bomb is small (under a few MB) — proves we have a real bomb.
    const compressedSize = statSync(ZIP_BOMB_ZIP).size;
    expect(compressedSize).toBeLessThan(1_000_000);

    const start = Date.now();
    let err: unknown;
    try {
      await unpackZip(buf, {
        maxFiles: 1000,
        maxFileSize: 200 * 1024 * 1024, // allow per-file bigger so we hit the CUMULATIVE cap, not file_size
        maxTotalUncompressed: 100 * 1024 * 1024,
      });
    } catch (e) {
      err = e;
    }
    const elapsed = Date.now() - start;
    expect(err).toBeInstanceOf(BatchLimitError);
    expect((err as BatchLimitError).limit).toBe('total_uncompressed_size');
    // Streaming abort, not a full unpack — wall time should be well under 2s on any laptop.
    expect(elapsed).toBeLessThan(2_000);
  });

  it('directories ignored: yazl-emitted directory entries are not returned', async () => {
    const buf = await makeZipBuffer((z) => {
      z.addEmptyDirectory('docs/');
      z.addBuffer(Buffer.from('# Hi', 'utf8'), 'docs/hi.md');
    });
    const out = await unpackZip(buf, {
      maxFiles: 100,
      maxFileSize: 1024 * 1024,
      maxTotalUncompressed: 1024 * 1024,
    });
    expect(out).toHaveLength(1);
    expect(out[0].path).toBe('docs/hi.md');
    expect(out[0].content).toBe('# Hi');
  });

  it('binary entries: returns best-effort utf8 decode without throwing (endpoint filters non-md)', async () => {
    // Tiny PNG-like header (not a real PNG, just non-utf8 bytes).
    const binary = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const buf = await makeZipBuffer((z) => {
      z.addBuffer(binary, 'image.png');
      z.addBuffer(Buffer.from('# real markdown', 'utf8'), 'a.md');
    });
    const out = await unpackZip(buf, {
      maxFiles: 100,
      maxFileSize: 1024 * 1024,
      maxTotalUncompressed: 1024 * 1024,
    });
    expect(out).toHaveLength(2);
    const png = out.find((e) => e.path === 'image.png');
    const md = out.find((e) => e.path === 'a.md');
    expect(png).toBeTruthy();
    expect(md).toBeTruthy();
    expect(typeof png!.content).toBe('string'); // decoded best-effort
    expect(md!.content).toBe('# real markdown');
  });
});

describe('BatchLimitError (Phase 11-03 Task 1)', () => {
  it('exposes limit + max properties; message names which limit', () => {
    const e = new BatchLimitError('zip_size', 50 * 1024 * 1024);
    expect(e).toBeInstanceOf(Error);
    expect(e.limit).toBe('zip_size');
    expect(e.max).toBe(50 * 1024 * 1024);
    expect(e.message).toMatch(/zip_size/);
    expect(e.message).toMatch(String(50 * 1024 * 1024));
  });
});
