#!/usr/bin/env bash
# proxy-smoke.sh — verify a Weltbon deployment behind a reverse proxy (PROXY-05).
#
# Probes four endpoints in sequence and exits non-zero on any failure:
#   1. GET /api/openapi.json                     (expect 200 + body containing "openapi")
#   2. GET /api/docs                              (expect 200 + body containing id="api-reference")
#   3. GET /universes/00000000-aaaa-bbbb-cccc-dddddddddddd/entries
#                                                 (deep SPA route — expect 200 + body containing <div id="root">)
#   4. GET /api/universes  -H "Authorization: Bearer $PROXY_SMOKE_PAT"
#                                                 (authenticated API call — expect 200 + JSON array)
#
# Required environment:
#   WELTBON_PROXY_URL   — the public base URL, e.g. https://welt.example.com
#   PROXY_SMOKE_PAT     — a Personal Access Token (prefix wbn_pat_) minted at /settings/tokens
#
# Usage:
#   WELTBON_PROXY_URL=https://welt.example.com \
#   PROXY_SMOKE_PAT=wbn_pat_xxxxxxxxxxxxxxxxxxxxxxxxxxxx \
#     ./scripts/proxy-smoke.sh

set -euo pipefail

: "${WELTBON_PROXY_URL:?WELTBON_PROXY_URL must be set (e.g. https://welt.example.com)}"
: "${PROXY_SMOKE_PAT:?PROXY_SMOKE_PAT must be set (e.g. wbn_pat_...)}"

BASE="${WELTBON_PROXY_URL%/}"
PASS_MARK="[PASS]"
FAIL_MARK="[FAIL]"

fail() {
  echo "${FAIL_MARK} $*" >&2
  exit 1
}

# Run one leg. Args: <leg name> <url> <expected substring> [auth header value (or empty)].
run_leg() {
  local name="$1"
  local url="$2"
  local needle="$3"
  local auth="${4:-}"

  local tmp
  tmp="$(mktemp)"
  local http_code
  if [ -n "$auth" ]; then
    http_code="$(curl --silent --show-error --output "$tmp" --write-out '%{http_code}' \
      --max-time 15 --header "Authorization: Bearer ${auth}" "$url")" \
      || fail "${name}: curl exited non-zero (network error)"
  else
    http_code="$(curl --silent --show-error --output "$tmp" --write-out '%{http_code}' \
      --max-time 15 "$url")" \
      || fail "${name}: curl exited non-zero (network error)"
  fi

  local size
  size="$(wc -c < "$tmp" | tr -d ' ')"

  if [ "$http_code" != "200" ]; then
    rm -f "$tmp"
    fail "${name}: expected HTTP 200, got ${http_code}"
  fi
  if ! grep -q -F "$needle" "$tmp"; then
    rm -f "$tmp"
    fail "${name}: response did NOT contain expected substring '${needle}'"
  fi
  rm -f "$tmp"
  printf '%s %-44s HTTP %s, %s bytes\n' "$PASS_MARK" "$name" "$http_code" "$size"
}

echo "Smoking ${BASE} ..."
run_leg "/api/openapi.json"                                                "${BASE}/api/openapi.json"                                                       '"openapi"'         ""
run_leg "/api/docs"                                                        "${BASE}/api/docs"                                                               'id="api-reference"' ""
run_leg "/universes/<deep-spa-route>/entries"                              "${BASE}/universes/00000000-aaaa-bbbb-cccc-dddddddddddd/entries"                 '<div id="root">'   ""
run_leg "/api/universes  (Bearer)"                                         "${BASE}/api/universes"                                                          '['                 "${PROXY_SMOKE_PAT}"

echo ""
echo "All 4 legs passed. Weltbon is reachable via ${BASE}."
