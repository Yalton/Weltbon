#!/usr/bin/env bash
# typecheck-baseline.sh — measure the api TypeScript error baseline.
#
# Exists because the baseline kept being quoted from memory and went stale: docs
# across this repo say "63", which was correct when written and is not now. A
# number in prose cannot self-correct; this command can. Quote its output, not a
# document.
#
# Two DIFFERENT counts get conflated, which is most of the confusion:
#
#   whole   `tsc --noEmit`                    — src + tests. The figure the
#                                               handoff docs mean by "baseline".
#   build   `tsc -p tsconfig.build.json`      — src only, tests excluded. What
#                                               `build:docker` and desktop's
#                                               `build:app` actually compile, so
#                                               the only one that gates a build.
#
# The whole-project count is dominated by test files, so it moves for reasons
# that never touch shipped code. Prefer the build count when deciding whether a
# change made things worse.
#
# Trap this script exists to sidestep: `pnpm exec tsc` does NOT run the compiler
# here — from api/, from the repo root, and via `pnpm exec --dir api tsc`, it
# prints nothing and exits 0. Only the binary at ./node_modules/.bin/tsc reports
# a true count.
#
# Usage:
#   ./scripts/typecheck-baseline.sh              # print both counts
#   ./scripts/typecheck-baseline.sh --max-build N   # also fail if build count > N
#
# Exits 0 on measurement success. tsc's own non-zero exit is expected (the
# baseline is not 0) and is not treated as failure.

set -euo pipefail

MAX_BUILD=""
while [ $# -gt 0 ]; do
  case "$1" in
    --max-build) MAX_BUILD="${2:?--max-build needs a number}"; shift 2 ;;
    -h|--help)   sed -n '2,32p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *)           echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

API_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../api" && pwd)"
TSC="$API_DIR/node_modules/.bin/tsc"

[ -x "$TSC" ] || { echo "no tsc at $TSC — run pnpm install first" >&2; exit 1; }

cd "$API_DIR"
export NODE_OPTIONS="${NODE_OPTIONS:---max-old-space-size=4096}"

# tsc exits non-zero whenever it reports errors, which is the normal state here,
# so `|| true` keeps set -e from killing the measurement.
WHOLE_OUT="$("$TSC" --noEmit 2>&1 || true)"
BUILD_OUT="$("$TSC" -p tsconfig.build.json --noEmit 2>&1 || true)"

count() { printf '%s\n' "$1" | grep -cE 'error TS' || true; }

WHOLE="$(count "$WHOLE_OUT")"
BUILD="$(count "$BUILD_OUT")"
IN_TESTS=$(( WHOLE - BUILD ))

echo "api TypeScript error baseline — measured $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo
printf '  whole project  (tsc --noEmit)                 %s\n' "$WHOLE"
printf '  build project  (tsc -p tsconfig.build.json)   %s   <- gates the build\n' "$BUILD"
printf '  difference     (tests/ and other excluded)    %s\n' "$IN_TESTS"
echo
echo "  shipped-code errors by file:"
printf '%s\n' "$BUILD_OUT" | grep -E 'error TS' | cut -d'(' -f1 | sort | uniq -c | sort -rn \
  | sed 's/^/    /'

if [ -n "$MAX_BUILD" ]; then
  echo
  if [ "$BUILD" -gt "$MAX_BUILD" ]; then
    echo "FAIL: build-project errors $BUILD exceed --max-build $MAX_BUILD"
    exit 1
  fi
  echo "OK: build-project errors $BUILD within --max-build $MAX_BUILD"
fi
