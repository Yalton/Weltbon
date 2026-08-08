#!/usr/bin/env bash
# Stage a self-contained copy of the API for packaging (issue #6).
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
# drizzle migrations directory. Keeping the whole tree unpacked avoids the
# app.asar.unpacked path-rewriting class of bug entirely, in the component that
# holds the user's only copy of their data.
#
# Why `pnpm deploy`: pnpm's normal node_modules is a forest of symlinks into
# .pnpm/, which electron-builder does not reliably pack. `pnpm deploy --prod`
# produces a hoisted, real, production-only tree. The Dockerfile already uses
# exactly this mechanism (see `pnpm deploy --filter @weltbon/api --prod` there),
# so this is a proven path rather than a new invention.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
STAGE_ROOT="$REPO/desktop/.stage"
STAGE="$STAGE_ROOT/api"

echo "[stage] repo:  $REPO"
echo "[stage] stage: $STAGE"

rm -rf "$STAGE_ROOT"
mkdir -p "$STAGE_ROOT"

echo "[stage] 1/5 building the web bundle"
(cd "$REPO/web" && ./node_modules/.bin/vite build)

# The api typecheck has a documented, pre-existing 63-error baseline, so `tsc`
# exits non-zero on a perfectly good tree. `|| true` matches the repo's own
# `build:docker` script. It does NOT hide a real regression: the baseline is
# asserted separately in CI and in the definition of done.
echo "[stage] 2/5 building the api (63-error baseline is expected)"
# --max-old-space-size is not optional on a clean CI runner. Node's default
# old-space cap is around 2GB, and this build reproducibly dies at ~2030MB with
# "Ineffective mark-compacts near heap limit" — api/src/db/schema.ts has the
# circular-inference types behind several of the baseline errors, and drizzle's
# generics are expensive to check. It fits on a developer machine and does not
# fit on a GitHub runner, which is why this only showed up in CI.
echo "[stage]     (raising the heap: this build OOMs at Node's ~2GB default)"
(cd "$REPO/api" && NODE_OPTIONS="--max-old-space-size=4096" ./node_modules/.bin/tsc -p tsconfig.build.json) || true
# This assertion is load-bearing, not belt-and-braces. The `|| true` above is
# there for the documented 63-error baseline, and it would just as happily
# swallow an OOM, a missing binary, or a syntax error — leaving the staging to
# continue with no dist/ and fail somewhere much less obvious. It is what turned
# the CI OOM into a legible failure instead of a confusing one downstream.
test -f "$REPO/api/dist/index.js" || { echo "[stage] FATAL: api/dist/index.js missing after build"; exit 1; }

echo "[stage] 3/5 pnpm deploy → hoisted prod-only api tree"
(cd "$REPO" && pnpm deploy --filter @weltbon/api --prod "$STAGE")

echo "[stage] 4/5 copying what deploy does not carry"
# `pnpm deploy` honours the package's file set; the Dockerfile copies these two
# from the source tree for the same reason. Assert rather than assume.
rm -rf "$STAGE/drizzle" "$STAGE/web-dist"
cp -r "$REPO/api/drizzle"  "$STAGE/drizzle"
cp -r "$REPO/web/dist"     "$STAGE/web-dist"
test -f "$STAGE/dist/index.js"              || { echo "[stage] FATAL: staged dist/index.js missing"; exit 1; }
test -f "$STAGE/drizzle/meta/_journal.json" || { echo "[stage] FATAL: staged migrations journal missing"; exit 1; }
test -f "$STAGE/web-dist/index.html"        || { echo "[stage] FATAL: staged web-dist/index.html missing"; exit 1; }

echo "[stage] 5/5 rebuilding native modules for Electron's ABI, in the staged tree"
# bcrypt and sharp are compiled against Node's ABI by default. They IMPORT fine
# either way and fail at the first real call, so this step failing silently is
# the difference between a working app and one that dies creating its first user.
(cd "$REPO/desktop" && ./node_modules/.bin/electron-rebuild -f -w bcrypt,sharp -m "$STAGE")

echo "[stage] done: $STAGE"
du -sh "$STAGE"
