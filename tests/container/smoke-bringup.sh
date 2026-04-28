#!/usr/bin/env bash
# smoke-bringup.sh — covers CONT-01.
#
# Asserts that the running container stack:
#   1. has a healthy /health endpoint (within 60s of invocation)
#   2. serves the SPA shell at / (HTTP 200 + index.html markers)
#   3. accepts a register/login flow with the seeded invite code
#
# Pre-requisite: the caller (smoke.sh) has already run `docker compose up -d`
# and exported INVITE_CODE. This script does NOT bring the stack up itself.

set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)

# shellcheck source=tests/container/seed.sh
source "$SCRIPT_DIR/seed.sh"

: "${API_BASE:=http://localhost:3000}"
: "${HEALTH_TIMEOUT_SECONDS:=60}"

echo "[smoke-bringup] waiting up to ${HEALTH_TIMEOUT_SECONDS}s for $API_BASE/health"

deadline=$(( $(date +%s) + HEALTH_TIMEOUT_SECONDS ))
while :; do
  if body=$(curl -fsS "$API_BASE/health" 2>/dev/null); then
    if echo "$body" | grep -q '"ok":true'; then
      echo "[smoke-bringup] /health OK after $(( $(date +%s) - (deadline - HEALTH_TIMEOUT_SECONDS) ))s"
      break
    fi
  fi
  if [[ $(date +%s) -ge $deadline ]]; then
    echo "[smoke-bringup] FAIL: /health did not return ok=true within ${HEALTH_TIMEOUT_SECONDS}s" >&2
    exit 1
  fi
  sleep 2
done

# 2. SPA shell at /
echo "[smoke-bringup] checking SPA shell at $API_BASE/"
spa_body=$(curl -fsS "$API_BASE/")
if ! echo "$spa_body" | grep -qiE '<div id="root">|<!doctype html>'; then
  echo "[smoke-bringup] FAIL: $API_BASE/ did not return SPA HTML (no <div id=\"root\"> or <!doctype html>)" >&2
  echo "--- response begin ---" >&2
  echo "$spa_body" | head -20 >&2
  echo "--- response end ---" >&2
  exit 1
fi

# 3. Invite-seeded register/login round trip
echo "[smoke-bringup] running seed_token (register or login)"
TOKEN=$(seed_token)
if [[ -z "$TOKEN" || "$TOKEN" == "null" ]]; then
  echo "[smoke-bringup] FAIL: seed_token did not yield an access token" >&2
  exit 1
fi
echo "[smoke-bringup] access token length=${#TOKEN}"

echo "[smoke-bringup] PASS"
