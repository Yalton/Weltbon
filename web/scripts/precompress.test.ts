import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { brotliDecompressSync, gunzipSync } from 'node:zlib';
// @ts-expect-error -- plain .mjs build script without type declarations
import { precompress } from './precompress.mjs';

describe('precompress', () => {
  let dir = '';
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('writes .br and .gz copies of large text files, recursively, and skips the rest', () => {
    dir = mkdtempSync(join(tmpdir(), 'weltbon-precompress-'));
    mkdirSync(join(dir, 'assets'));
    const js = 'export const x = 1;\n'.repeat(200);
    writeFileSync(join(dir, 'assets', 'index-abc.js'), js);
    writeFileSync(join(dir, 'tiny.css'), 'a{}');
    writeFileSync(join(dir, 'icon.png'), Buffer.alloc(4096));

    expect(precompress(dir)).toBe(1);
    expect(brotliDecompressSync(readFileSync(join(dir, 'assets', 'index-abc.js.br'))).toString()).toBe(js);
    expect(gunzipSync(readFileSync(join(dir, 'assets', 'index-abc.js.gz'))).toString()).toBe(js);
    expect(existsSync(join(dir, 'tiny.css.br'))).toBe(false);
    expect(existsSync(join(dir, 'icon.png.br'))).toBe(false);
  });
});
