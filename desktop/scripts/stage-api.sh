#!/usr/bin/env bash
# Stage a self-contained copy of the API for packaging (issue #6, reworked for #8).
#
# electron-builder ships this directory as `extraResources`, so it lands at
# <resources>/api/ next to app.asar. That is exactly where main.ts's existing
# derivation already looks:
#
#   apiEntry = join(app.getAppPath(), '..', 'api', 'dist', 'index.js')
#              = <resources>/app.asar/../api/dist/index.js
#              = <resources>/api/dist/index.js
#
# so the packaged layout needs NO change to the path derivation.
#
# Why outside the asar rather than asarUnpack: everything here needs a real
# filesystem path, not Electron's asar-transparent fs shim — the native .node
# files (dlopen cannot read from an archive), PGlite's WASM payload, and the
# drizzle migrations directory.
#
# ── WHY A BUNDLE, NOT `pnpm deploy` (issue #8) ───────────────────────────────
# This script used to ship a node_modules tree produced by `pnpm deploy`. That
# is pnpm's ISOLATED layout: every top-level entry is a symlink into a bundled
# `.pnpm/`, and a package's own dependencies sit beside it inside its store
# entry. Node resolves the symlink to its real path first, so resolution works —
# on Linux and macOS.
#
# Windows packaging does not preserve those symlinks. electron-builder writes
# real copies where the links were, which severs each package from its store
# entry and makes its transitive dependencies unreachable, because in an
# isolated layout they are never at the top level. The first Windows build to
# compile green died instantly on
# `ERR_MODULE_NOT_FOUND: '@asteasolutions/zod-to-openapi'` — a package that was
# present in the installer the whole time, just unreachable.
#
# `node-linker=hoisted` is not the fix: pnpm discards the lockfile in that mode
# and re-resolves the whole graph (30 packages moved when measured, including
# sharp), and hoisting has one top-level slot per name, so a transitive can
# evict a direct dependency outright.
#
# So the API is bundled instead. A bundle has no node_modules layout at all:
# nothing to symlink, nothing to hoist, nothing to lose in translation. Only
# packages that CANNOT be bundled stay external, and those are installed flat
# with npm, which never produces symlinks.
#
# Bundling also removes `tsc` from this script. esbuild strips types itself, so
# the API's documented 63-error baseline and the CI heap exhaustion that came
# with typechecking here are no longer staging's problem. Typechecking still
# happens in CI, where it belongs.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
STAGE_ROOT="$REPO/desktop/.stage"
STAGE="$STAGE_ROOT/api"
ESBUILD="$REPO/desktop/node_modules/.bin/esbuild"

# Packages that must NOT be bundled, and why each one resists it:
#   bcrypt, sharp            native .node binaries, rebuilt against Electron's ABI
#   @electric-sql/pglite     ships a WASM payload loaded from disk
#   pg                       only reached in server mode, and pulls pg-native
#   pg-native                optional native peer of pg; pg tolerates its absence
EXTERNALS=(bcrypt sharp @electric-sql/pglite pg)

# The platform the packaged app will RUN on, which is not always the build host:
# the Windows installer is built on Linux under Wine. Native binaries must match
# the target, so step 3 installs the target's prebuilt binaries.
HOST_PLATFORM="$(node -p process.platform)"
HOST_ARCH="$(node -p process.arch)"
TARGET_PLATFORM="${WELTBON_TARGET_PLATFORM:-$HOST_PLATFORM}"
TARGET_ARCH="${WELTBON_TARGET_ARCH:-$HOST_ARCH}"

echo "[stage] repo:  $REPO"
echo "[stage] stage: $STAGE"
echo "[stage] target: $TARGET_PLATFORM-$TARGET_ARCH (host $HOST_PLATFORM-$HOST_ARCH)"

rm -rf "$STAGE_ROOT"
mkdir -p "$STAGE/dist"

echo "[stage] 1/6 building the web bundle"
(cd "$REPO/web" && ./node_modules/.bin/vite build)

echo "[stage] 2/6 bundling the api into a single file"
# --banner: ESM output has no `require`, but bundled CJS dependencies still call
# it. Without this the app dies at startup on `Dynamic require of "fs" is not
# supported`. __filename/__dirname are provided for the same reason.
test -x "$ESBUILD" || { echo "[stage] FATAL: esbuild missing — run pnpm install in desktop/"; exit 1; }
"$ESBUILD" "$REPO/api/src/index.ts" \
  --bundle \
  --platform=node \
  --format=esm \
  --target=node22 \
  $(printf -- '--external:%s ' "${EXTERNALS[@]}") \
  --external:pg-native \
  --banner:js='import{createRequire as __cr}from"node:module";import{fileURLToPath as __f}from"node:url";import{dirname as __d}from"node:path";const require=__cr(import.meta.url);const __filename=__f(import.meta.url);const __dirname=__d(__filename);' \
  --outfile="$STAGE/dist/index.js"
test -f "$STAGE/dist/index.js" || { echo "[stage] FATAL: bundle missing after esbuild"; exit 1; }

echo "[stage] 3/6 installing the unbundlable externals as a flat tree"
# npm, not pnpm: npm's layout has no symlinks, which is the entire point. The
# versions come from the api's own installed tree so the staged copies match the
# lockfile exactly rather than whatever the registry resolves today.
node "$REPO/desktop/scripts/write-stage-manifest.mjs" "$REPO" "$STAGE" "${EXTERNALS[@]}"
# --os/--cpu pick the target's optional dependencies, which is how sharp ships
# its per-platform binaries (@img/sharp-win32-x64 and so on). bcrypt carries
# prebuilds for every platform in the package itself.
(cd "$STAGE" && npm install --omit=dev --no-audit --no-fund --loglevel=error \
  --os="$TARGET_PLATFORM" --cpu="$TARGET_ARCH")

echo "[stage] 4/6 copying what the bundle cannot carry"
# Migrations and the SPA are read from disk at runtime. Fonts join them now: the
# bundle collapses module depth, so pdf/fonts.ts's relative walk no longer
# resolves and main.ts points WELTBON_FONT_DIR at this copy instead.
rm -rf "$STAGE/drizzle" "$STAGE/web-dist" "$STAGE/assets"
cp -r "$REPO/api/drizzle" "$STAGE/drizzle"
cp -r "$REPO/web/dist"    "$STAGE/web-dist"
mkdir -p "$STAGE/assets"
cp -r "$REPO/api/assets/fonts" "$STAGE/assets/fonts" 2>/dev/null || echo "[stage]     (no api/assets/fonts to copy — PDF export falls back to system fonts)"
test -f "$STAGE/drizzle/meta/_journal.json" || { echo "[stage] FATAL: staged migrations journal missing"; exit 1; }
test -f "$STAGE/web-dist/index.html"        || { echo "[stage] FATAL: staged web-dist/index.html missing"; exit 1; }

# Build identity for the packaged app. main.ts reads this file and exports the
# values as env before importing the API (desktop/src/build-info.ts explains why
# a file rather than an esbuild --define: api/src/version.ts reads process.env
# through a variable, which --define cannot substitute).
#
# WELTBON_VERSION may be set by the caller — the release workflow passes the tag
# being built. Falling back to desktop/package.json keeps a local `pnpm dist`
# honest rather than stamping an empty version.
STAGE_VERSION="${WELTBON_VERSION:-$(node -p "require('$REPO/package.json').version")}"
STAGE_COMMIT="${WELTBON_COMMIT:-$(git -C "$REPO" rev-parse --short HEAD 2>/dev/null || echo '')}"
STAGE_BUILT_AT="${WELTBON_BUILT_AT:-$(date -u +%Y-%m-%dT%H:%M:%SZ)}"
node -e '
  const [version, commit, builtAt, out] = process.argv.slice(1);
  require("node:fs").writeFileSync(out, JSON.stringify({
    version,
    commit: commit || null,
    builtAt: builtAt || null,
  }, null, 2) + "\n");
' "$STAGE_VERSION" "$STAGE_COMMIT" "$STAGE_BUILT_AT" "$STAGE/version.json"
echo "[stage]     build identity: $STAGE_VERSION${STAGE_COMMIT:+ ($STAGE_COMMIT)}"

echo "[stage] 5/6 native modules: using the prebuilt Node-API binaries"
# No electron-rebuild. bcrypt and sharp ship prebuilt binaries for each
# platform, and both use Node-API, whose ABI is the same under Node and
# Electron, so the prebuilds load as installed (checked: bcrypt hashes and
# sharp encodes under Electron's runtime with no rebuild). Rebuilding was
# harmful: it compiles for the HOST, so a Linux bcrypt_lib.node in build/Release
# shadowed the Windows prebuild in the Windows installer, and it needs a
# C++20 compiler the release runner image (Ubuntu 20.04, gcc 9) lacks.
# Step 6 checks every staged binary matches the target platform.

echo "[stage] 6/6 asserting the properties that only fail on Windows"
WELTBON_TARGET_PLATFORM="$TARGET_PLATFORM" WELTBON_TARGET_ARCH="$TARGET_ARCH" \
  node "$REPO/desktop/scripts/assert-staged-tree.mjs" "$STAGE" "${EXTERNALS[@]}"

echo "[stage] done: $STAGE"
du -sh "$STAGE"
