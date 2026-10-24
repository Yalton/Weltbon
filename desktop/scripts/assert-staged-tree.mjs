// Assert the staged tree is actually shippable (issue #8).
//
// WHY THIS EXISTS. The Windows build that shipped broken was green. Staging
// asserted that files EXISTED — dist/index.js, the migrations journal,
// web-dist/index.html — and never that they were RESOLVABLE. The broken
// property was invisible on the build host, because on Linux the symlinks
// pnpm produced worked fine; it only failed once Windows packaging replaced
// them with copies. A test suite that runs on Linux can never catch that.
//
// So these checks assert the two properties that differ between the platforms,
// and they run on every stage — including the Linux one, where they would have
// caught the bug before it was ever packaged for Windows.
//
// Usage: node assert-staged-tree.mjs <stage> <external...>

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const [, , STAGE, ...externals] = process.argv;
if (!STAGE) {
  console.error('usage: assert-staged-tree.mjs <stage> <external...>');
  process.exit(2);
}

const problems = [];
const note = (msg) => console.log(`[assert-stage] ${msg}`);

// ── 1. the entry point the packaged app actually imports ────────────────────
const entry = join(STAGE, 'dist', 'index.js');
if (!existsSync(entry)) {
  problems.push(`missing entry point: ${entry}`);
} else if (statSync(entry).size < 1024) {
  // A truncated or stub bundle is worse than a missing one: packaging succeeds
  // and the failure surfaces only at launch, which is exactly how #8 shipped.
  problems.push(`entry point is implausibly small (${statSync(entry).size} bytes) — bundle likely failed`);
} else {
  note(`entry point ok (${(statSync(entry).size / 1e6).toFixed(1)} MB)`);
}

// ── 2. NO symlinks outside .bin ─────────────────────────────────────────────
// This is the invariant Windows packaging destroys. A symlink surviving here
// means the staged tree depends on link preservation, and the packaged app will
// fail to resolve something the moment it is built for Windows.
const symlinks = [];
(function walk(dir) {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isSymbolicLink()) {
      if (!relative(STAGE, full).split(sep).includes('.bin')) symlinks.push(relative(STAGE, full));
    } else if (entry.isDirectory()) {
      walk(full);
    }
  }
})(join(STAGE, 'node_modules'));

if (symlinks.length) {
  problems.push(
    `${symlinks.length} symlink(s) outside .bin survive in the staged tree. ` +
    `Windows packaging dereferences these, severing each package from its private ` +
    `dependencies:\n    ` + symlinks.slice(0, 10).join('\n    '),
  );
} else {
  note('no symlinks outside .bin');
}

// ── 3. every declared external is present and importable-looking ────────────
// The bundle assumes these exist at runtime. If one is missing the app dies at
// launch with the same class of error #8 produced.
for (const name of externals) {
  const pkgJson = join(STAGE, 'node_modules', ...name.split('/'), 'package.json');
  if (!existsSync(pkgJson)) {
    problems.push(`declared external not installed in the staged tree: ${name}`);
    continue;
  }
  const { version } = JSON.parse(readFileSync(pkgJson, 'utf8'));
  note(`external ${name}@${version}`);
}

// ── 4. runtime assets the bundle cannot carry ───────────────────────────────
for (const [label, rel] of [
  ['migrations journal', join('drizzle', 'meta', '_journal.json')],
  ['web SPA', join('web-dist', 'index.html')],
]) {
  if (!existsSync(join(STAGE, rel))) problems.push(`missing ${label}: ${rel}`);
}

// ── 5. native binaries are built for the platform the app will run on ──────
// The Windows installer is staged on Linux. A Linux .node file in it imports
// nothing until the first bcrypt or sharp call, then the app fails — and a
// Linux build host cannot load a Windows binary to find out. So check the file
// format instead: PE for Windows, ELF for Linux, Mach-O for macOS. bcrypt ships
// prebuilds for every platform; only the target's directory is ever loaded.
const target = `${process.env.WELTBON_TARGET_PLATFORM || process.platform}-${process.env.WELTBON_TARGET_ARCH || process.arch}`;
const [targetPlatform] = target.split('-');
const formatOf = (file) => {
  const b = readFileSync(file).subarray(0, 4);
  if (b[0] === 0x4d && b[1] === 0x5a) return 'win32';
  if (b[0] === 0x7f && b.toString('latin1', 1, 4) === 'ELF') return 'linux';
  if ([0xcffaedfe, 0xcefaedfe, 0xcafebabe].includes(b.readUInt32BE(0))) return 'darwin';
  return 'unknown';
};
const nativeFiles = [];
(function walk(dir) {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (relative(STAGE, dir).split(sep).at(-1) === 'prebuilds' && entry.name !== target) continue;
      walk(full);
    } else if (entry.name.endsWith('.node')) {
      nativeFiles.push(full);
    }
  }
})(join(STAGE, 'node_modules'));

const wrongFormat = nativeFiles.filter((f) => formatOf(f) !== targetPlatform);
if (wrongFormat.length) {
  problems.push(
    `${wrongFormat.length} native binary(ies) are not ${targetPlatform} binaries, so the ${target} app cannot load them:\n    `
      + wrongFormat.map((f) => `${relative(STAGE, f)} (${formatOf(f)})`).join('\n    '),
  );
}
for (const [name, prefix] of [['bcrypt', join('node_modules', 'bcrypt')], ['sharp', join('node_modules', '@img', 'sharp-')]]) {
  if (!externals.includes(name)) continue;
  if (!nativeFiles.some((f) => relative(STAGE, f).startsWith(prefix) && formatOf(f) === targetPlatform)) {
    problems.push(`no ${target} native binary for ${name} in the staged tree`);
  }
}
if (!wrongFormat.length) note(`native binaries match ${target} (${nativeFiles.length} file(s))`);

if (problems.length) {
  console.error(`\n[assert-stage] FAILED — ${problems.length} problem(s):`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}

console.log('[assert-stage] ok — staged tree is flat, complete, and shippable');
