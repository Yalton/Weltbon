#!/usr/bin/env bash
# smoke-persist.sh — covers CONT-04b + ROADMAP success #5.
#
# Flow:
#   1. seed token; create universe "PersistU" (slug persist-u-<ts>)
#   2. create entry "Anchor"
#   3. PUT timeline pin {label:"Year One", position:1, precision:"exact"}
#   4. docker compose down (NOT -v — preserve volume)
#   5. docker compose up -d; wait for /health
#   6. re-login; GET universe + entry + timeline; assert IDs match
#
# IMPORTANT: this script intentionally never passes `-v` to `down` because
# the entire point of the test is to prove the named volume survives.

set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
REPO_ROOT=$(cd "$SCRIPT_DIR/../.." && pwd)

# shellcheck source=tests/container/seed.sh
source "$SCRIPT_DIR/seed.sh"

: "${API_BASE:=http://localhost:3000}"
: "${HEALTH_TIMEOUT_SECONDS:=60}"

command -v jq >/dev/null 2>&1 || { echo "[smoke-persist] FAIL: jq not found" >&2; exit 1; }
command -v docker >/dev/null 2>&1 || { echo "[smoke-persist] FAIL: docker not found" >&2; exit 1; }

# --- 1. token + universe ---------------------------------------------------
echo "[smoke-persist] acquiring access token"
TOKEN=$(seed_token)

SLUG="persist-u-$(date +%s)"
echo "[smoke-persist] creating universe slug=$SLUG"
UNIV_RES=$(curl -fsS -X POST "$API_BASE/universes" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d "$(printf '{"name":"PersistU","slug":"%s"}' "$SLUG")")
UID_VAL=$(echo "$UNIV_RES" | jq -r .id)
[[ -n "$UID_VAL" && "$UID_VAL" != "null" ]] || { echo "[smoke-persist] FAIL: no universe id" >&2; exit 1; }

# --- 2. entry --------------------------------------------------------------
echo "[smoke-persist] creating entry Anchor"
ENT_RES=$(curl -fsS -X POST "$API_BASE/universes/$UID_VAL/entries" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"title":"Anchor","type":"character"}')
EID=$(echo "$ENT_RES" | jq -r .id)
[[ -n "$EID" && "$EID" != "null" ]] || { echo "[smoke-persist] FAIL: no entry id" >&2; exit 1; }

# --- 3. timeline pin -------------------------------------------------------
echo "[smoke-persist] PUT timeline pin"
PIN_RES=$(curl -fsS -X PUT "$API_BASE/universes/$UID_VAL/entries/$EID/pin" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"label":"Year One","position":1,"precision":"exact"}')
PID=$(echo "$PIN_RES" | jq -r '.pin.id // .id')
[[ -n "$PID" && "$PID" != "null" ]] || { echo "[smoke-persist] FAIL: no pin id" >&2; exit 1; }

# --- 4. compose down (preserve volume) ------------------------------------
echo "[smoke-persist] docker compose down (preserving volume — NO -v flag)"
( cd "$REPO_ROOT" && docker compose down )

# --- 5. compose up + wait --------------------------------------------------
echo "[smoke-persist] docker compose up -d"
( cd "$REPO_ROOT" && docker compose up -d )

echo "[smoke-persist] waiting up to ${HEALTH_TIMEOUT_SECONDS}s for $API_BASE/health"
deadline=$(( $(date +%s) + HEALTH_TIMEOUT_SECONDS ))
while :; do
  if curl -fsS "$API_BASE/health" 2>/dev/null | grep -q '"ok":true'; then
    break
  fi
  if [[ $(date +%s) -ge $deadline ]]; then
    echo "[smoke-persist] FAIL: /health did not return after restart" >&2
    exit 1
  fi
  sleep 2
done

# --- 6. re-login + re-fetch -----------------------------------------------
echo "[smoke-persist] re-acquiring access token after restart"
TOKEN=$(seed_token)

echo "[smoke-persist] GET /universes/$UID_VAL"
GOT_UNIV=$(curl -fsS "$API_BASE/universes/$UID_VAL" -H "Authorization: Bearer $TOKEN")
GOT_UID=$(echo "$GOT_UNIV" | jq -r '.id // .universe.id')
if [[ "$GOT_UID" != "$UID_VAL" ]]; then
  echo "[smoke-persist] FAIL: universe id mismatch ($GOT_UID != $UID_VAL)" >&2
  exit 1
fi

echo "[smoke-persist] GET /universes/$UID_VAL/entries/$EID"
GOT_ENT=$(curl -fsS "$API_BASE/universes/$UID_VAL/entries/$EID" -H "Authorization: Bearer $TOKEN")
GOT_EID=$(echo "$GOT_ENT" | jq -r '.id // .entry.id')
if [[ "$GOT_EID" != "$EID" ]]; then
  echo "[smoke-persist] FAIL: entry id mismatch ($GOT_EID != $EID)" >&2
  exit 1
fi

echo "[smoke-persist] GET /universes/$UID_VAL/timeline (looking for pin $PID)"
GOT_TL=$(curl -fsS "$API_BASE/universes/$UID_VAL/timeline" -H "Authorization: Bearer $TOKEN")
if ! echo "$GOT_TL" | jq -e --arg pid "$PID" 'any(.[]?; .id == $pid) // any(.pins[]?; .id == $pid)' >/dev/null; then
  echo "[smoke-persist] FAIL: pin $PID not found in /timeline response" >&2
  echo "$GOT_TL" >&2
  exit 1
fi

echo "[smoke-persist] PASS"
