#!/usr/bin/env bash
# seed.sh — sourced helper for Phase 6 smoke scripts.
#
# Provides three functions used by smoke-pdf.sh and smoke-persist.sh:
#
#   seed_register   POSTs /auth/register; idempotent (falls back to login on 409)
#   seed_login      POSTs /auth/login; echoes accessToken
#   seed_token      register-or-login; echoes the resulting access token to stdout
#
# Reads INVITE_CODE from environment (set by smoke.sh from .env). Uses
# `curl -fsS` for HTTP and `jq -r .accessToken` to parse the response.
# Hard-fails with a stderr message if the API isn't reachable.
#
# Usage from a calling script:
#
#   source tests/container/seed.sh
#   TOKEN=$(seed_token)
#
# Calling scripts must enable `set -euo pipefail` themselves; this file is
# meant to be sourced, not executed.

set -euo pipefail

: "${API_BASE:=http://localhost:3000}"
: "${SMOKE_EMAIL:=smoke@weltbon.local}"
: "${SMOKE_PASSWORD:=smoke-test-password-123}"

# Internal: emit a stderr message and exit 1.
_seed_fail() {
  echo "[seed] $1" >&2
  exit 1
}

# Internal: confirm `jq` is on PATH before any function tries to use it.
_seed_check_jq() {
  command -v jq >/dev/null 2>&1 || _seed_fail "jq not found on PATH (apt install jq)"
}

# Register the smoke-test user. Echoes the access token on stdout.
# Returns non-zero on hard errors. On HTTP 409 (email already in use),
# falls back to seed_login() — making this idempotent across runs.
seed_register() {
  _seed_check_jq
  local body http_code response
  if [[ -z "${INVITE_CODE:-}" ]]; then
    _seed_fail "INVITE_CODE env var not set (smoke.sh must export from .env)"
  fi
  body=$(printf '{"email":"%s","password":"%s","inviteCode":"%s"}' \
    "$SMOKE_EMAIL" "$SMOKE_PASSWORD" "$INVITE_CODE")

  # Two-step curl: write body to file, capture HTTP status separately so we
  # can branch on 409 without `curl -f` aborting on the first non-2xx.
  local tmp
  tmp=$(mktemp)
  http_code=$(curl -sS -o "$tmp" -w '%{http_code}' \
    -X POST "$API_BASE/auth/register" \
    -H 'Content-Type: application/json' \
    -d "$body" || echo "000")

  if [[ "$http_code" == "201" ]]; then
    response=$(cat "$tmp")
    rm -f "$tmp"
    echo "$response" | jq -r .accessToken
    return 0
  fi
  if [[ "$http_code" == "409" ]]; then
    rm -f "$tmp"
    seed_login
    return $?
  fi
  if [[ "$http_code" == "000" ]]; then
    rm -f "$tmp"
    _seed_fail "API unreachable at $API_BASE (is the container up?)"
  fi
  echo "[seed] register failed with HTTP $http_code:" >&2
  cat "$tmp" >&2
  rm -f "$tmp"
  return 1
}

# Log in the smoke-test user. Echoes the access token on stdout.
seed_login() {
  _seed_check_jq
  local body
  body=$(printf '{"email":"%s","password":"%s"}' \
    "$SMOKE_EMAIL" "$SMOKE_PASSWORD")
  curl -fsS -X POST "$API_BASE/auth/login" \
    -H 'Content-Type: application/json' \
    -d "$body" \
    | jq -r .accessToken
}

# Run register-or-login; echo resulting access token. The canonical entry
# point used by every other smoke script.
seed_token() {
  local token
  token=$(seed_register)
  if [[ -z "$token" || "$token" == "null" ]]; then
    _seed_fail "no access token returned from register/login"
  fi
  echo "$token"
}
