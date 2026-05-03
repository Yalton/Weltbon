/**
 * Reproducible ZIP fixture builder for Phase 11-03 ingest-zip tests.
 *
 * Outputs:
 *   - valid-vault.zip   — vault-basic/ recursively zipped (yazl deflate)
 *   - zip-bomb.zip      — single 200 MB entry of 0x00 bytes (compresses to <1 MB)
 *
 * Idempotent: skips re-creation if both fixture files already exist.
 *
 * Run via:
 *   tsx api/tests/fixtures/ingest/zip/build-zips.ts
 *
 * Used by:
 *   - api/tests/ingest-zip.test.ts (beforeAll re-runs this script when fixtures absent)
 *   - api/tests/ingest-endpoint.test.ts (uses valid-vault.zip + zip-bomb.zip)
 */

import { createWriteStream, existsSync, readFileSync, statSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { dirname, join, posix, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
// yazl ships its own types via dependency tree; if @types/yazl unavailable we
// fall back to require-import with a structural shape declaration. yazl's API
// is small enough that we type only what we use.
import yazl from 'yazl';

interface ZipFileLike {
  addBuffer(buffer: Buffer, metadataPath: string): void;
  end(): void;
  outputStream: NodeJS.ReadableStream;
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const ZIP_DIR = __dirname;
const VALID_VAULT_ZIP = join(ZIP_DIR, 'valid-vault.zip');
const ZIP_BOMB_ZIP = join(ZIP_DIR, 'zip-bomb.zip');
const VAULT_BASIC_DIR = join(ZIP_DIR, '..', 'vault-basic');

async function walkFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  async function visit(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const ent of entries) {
      const abs = join(dir, ent.name);
      if (ent.isDirectory()) {
        await visit(abs);
      } else if (ent.isFile()) {
        out.push(abs);
      }
    }
  }
  await visit(root);
  return out.sort();
}

async function buildValidVaultZip(): Promise<void> {
  if (existsSync(VALID_VAULT_ZIP)) {
    console.log(`[build-zips] valid-vault.zip exists — skipping`);
    return;
  }
  if (!existsSync(VAULT_BASIC_DIR)) {
    throw new Error(
      `[build-zips] vault-basic/ not found at ${VAULT_BASIC_DIR} — fixture missing`
    );
  }

  const zip = new yazl.ZipFile() as unknown as ZipFileLike;
  const files = await walkFiles(VAULT_BASIC_DIR);
  console.log(`[build-zips] adding ${files.length} files to valid-vault.zip`);
  for (const abs of files) {
    const rel = relative(VAULT_BASIC_DIR, abs).split(sep).join(posix.sep);
    const buf = readFileSync(abs);
    zip.addBuffer(buf, rel);
  }
  zip.end();
  await new Promise<void>((resolve, reject) => {
    const out = createWriteStream(VALID_VAULT_ZIP);
    zip.outputStream.pipe(out);
    out.on('close', () => resolve());
    out.on('error', reject);
    zip.outputStream.on('error', reject);
  });
  console.log(`[build-zips] wrote ${VALID_VAULT_ZIP}`);
}

async function buildZipBombZip(): Promise<void> {
  if (existsSync(ZIP_BOMB_ZIP)) {
    console.log(`[build-zips] zip-bomb.zip exists — skipping`);
    return;
  }

  // 200 MB of 0x00 bytes — compresses to a few KB via DEFLATE.
  // yazl supports addBuffer; we allocate a 200 MB Buffer once, then let yazl
  // deflate it. For a fixture builder this is acceptable peak memory.
  const SIZE = 200 * 1024 * 1024;
  console.log(`[build-zips] allocating ${SIZE} byte zero buffer for zip-bomb`);
  const big = Buffer.alloc(SIZE, 0);

  const zip = new yazl.ZipFile() as unknown as ZipFileLike;
  // Single entry; uncompressedSize = 200 MB; compressed = tiny.
  zip.addBuffer(big, 'bomb.md');
  zip.end();
  await new Promise<void>((resolve, reject) => {
    const out = createWriteStream(ZIP_BOMB_ZIP);
    zip.outputStream.pipe(out);
    out.on('close', () => resolve());
    out.on('error', reject);
    zip.outputStream.on('error', reject);
  });
  const compressed = statSync(ZIP_BOMB_ZIP).size;
  console.log(
    `[build-zips] wrote ${ZIP_BOMB_ZIP} — uncompressed=${SIZE}, compressed=${compressed}`
  );
}

async function main(): Promise<void> {
  await buildValidVaultZip();
  await buildZipBombZip();
}

main().catch((err) => {
  console.error('[build-zips] failed:', err);
  process.exit(1);
});
