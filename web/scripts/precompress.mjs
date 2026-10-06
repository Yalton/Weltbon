// Write .br and .gz copies of the built text files so the API can serve them
// compressed without spending CPU on every request (see api/src/web-static.ts).
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { brotliCompressSync, constants, gzipSync } from 'node:zlib';

const COMPRESSIBLE = /\.(js|mjs|css|html|svg|json|webmanifest|txt|wasm)$/;
const MIN_BYTES = 1024;

export function precompress(dir) {
  let count = 0;
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) { count += precompress(path); continue; }
    if (!COMPRESSIBLE.test(name)) continue;
    const data = readFileSync(path);
    if (data.length < MIN_BYTES) continue;
    writeFileSync(`${path}.br`, brotliCompressSync(data, {
      params: { [constants.BROTLI_PARAM_QUALITY]: 11, [constants.BROTLI_PARAM_SIZE_HINT]: data.length },
    }));
    writeFileSync(`${path}.gz`, gzipSync(data, { level: 9 }));
    count += 1;
  }
  return count;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const dir = process.argv[2] ?? 'dist';
  console.log(`precompress: ${precompress(dir)} files in ${dir}`);
}
