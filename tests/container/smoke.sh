#!/usr/bin/env bash
# smoke.sh — top-level orchestrator for Phase 6's container smoke suite.
#
# Steps:
#   1. Load .env from repo root; export INVITE_CODE / POSTGRES_PASSWORD /
#      JWT_SECRET. If .env is missing, copy .env.example and bail with
#      instructions.
#   2. Detect whether the runtime image (weltbon:test) exists. During
#      Wave 0 it does NOT — exit 0 with a clear stderr message that points
#      at Plan 06-02 (Dockerfile) + Plan 06-04 (wires this script).
#   3. Once a Dockerfile exists: build, run check-size.sh, compose up -d,
#      run smoke-bringup.sh, smoke-pdf.sh, smoke-persist.sh in sequence.
#   4. On any failure, dump `docker compose logs app | tail -100` to stderr.
#   5. On full pass, echo the green-light banner.

set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
REPO_ROOT=$(cd "$SCRIPT_DIR/../.." && pwd)
cd "$REPO_ROOT"

: "${IMAGE_TAG:=weltbon:test}"

# --- 1. .env handling ------------------------------------------------------
if [[ ! -f .env ]]; then
  if [[ -f .env.example ]]; then
    cp .env.example .env
    echo "[smoke] .env was missing — copied .env.example to .env." >&2
    echo "[smoke] Edit .env and set INVITE_CODE, POSTGRES_PASSWORD, JWT_SECRET, then re-run." >&2
    exit 1
  fi
  echo "[smoke] FAIL: neither .env nor .env.example found at repo root" >&2
  exit 1
fi

# Export every KEY=VALUE line from .env (skip blanks + comments).
set -a
# shellcheck disable=SC1091
source ./.env
set +a

# Sanity-check the three vars the smoke suite actually needs.
for var in INVITE_CODE POSTGRES_PASSWORD JWT_SECRET; do
  if [[ -z "${!var:-}" ]]; then
    echo "[smoke] FAIL: $var is empty in .env" >&2
    exit 1
  fi
done

# --- 2. image-exists gate (Wave 0 short-circuit) --------------------------
if ! docker image inspect "$IMAGE_TAG" >/dev/null 2>&1; then
  echo "[smoke] $IMAGE_TAG image not built — Plan 06-02 (Dockerfile) must run first; Plan 06-04 wires this script into CI." >&2
  echo "[smoke] During Wave 0 this is expected; exiting 0 so the Wave 0 gate stays green." >&2
  exit 0
fi

# --- 3. orchestrated suite -------------------------------------------------
abort() {
  echo "[smoke] FAIL at step: $1" >&2
  echo "[smoke] dumping last 100 lines of app logs:" >&2
  docker compose logs app 2>/dev/null | tail -100 >&2 || true
  exit 1
}

echo "[smoke] check-size"
bash "$SCRIPT_DIR/check-size.sh" || abort check-size

echo "[smoke] docker compose up -d"
docker compose up -d || abort "compose up"

echo "[smoke] smoke-bringup"
bash "$SCRIPT_DIR/smoke-bringup.sh" || abort smoke-bringup

echo "[smoke] smoke-pdf"
bash "$SCRIPT_DIR/smoke-pdf.sh" || abort smoke-pdf

echo "[smoke] smoke-persist"
bash "$SCRIPT_DIR/smoke-persist.sh" || abort smoke-persist

echo "[smoke] ALL PASS — Phase 6 success criteria green"
