#!/usr/bin/env bash
# smoke-pdf.sh — covers CONT-02 (closes EXP-03 on the container path).
#
# Flow:
#   1. seed token (register-or-login)
#   2. POST /universes (Smoke / smoke)
#   3. POST 3 entries (Aragorn/character, Mordor/location, The One Ring/item)
#   4. POST /universes/:uid/export?format=pdf -> /tmp/weltbon-smoke.pdf
#   5. assert file non-empty + %PDF magic bytes
#   6. assert pdf-parse: numpages > 0, contains "Aragorn"
#   7. echo PASS
#
# pdf-parse runs on the HOST via api/node_modules; /tmp on host is fine
# because curl writes the binary there directly.

set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
REPO_ROOT=$(cd "$SCRIPT_DIR/../.." && pwd)

# shellcheck source=tests/container/seed.sh
source "$SCRIPT_DIR/seed.sh"

: "${API_BASE:=http://localhost:3000}"
: "${PDF_OUT:=/tmp/weltbon-smoke.pdf}"

command -v jq >/dev/null 2>&1 || { echo "[smoke-pdf] FAIL: jq not found" >&2; exit 1; }
command -v node >/dev/null 2>&1 || { echo "[smoke-pdf] FAIL: node not found" >&2; exit 1; }

echo "[smoke-pdf] acquiring access token"
TOKEN=$(seed_token)

# --- 2. create universe ----------------------------------------------------
# Use a unique slug per run so repeat invocations don't collide on UNIQUE.
SLUG="smoke-$(date +%s)"
echo "[smoke-pdf] creating universe slug=$SLUG"
UNIV_BODY=$(printf '{"name":"Smoke","slug":"%s"}' "$SLUG")
UNIV_RES=$(curl -fsS -X POST "$API_BASE/universes" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d "$UNIV_BODY")
UID_VAL=$(echo "$UNIV_RES" | jq -r .id)
if [[ -z "$UID_VAL" || "$UID_VAL" == "null" ]]; then
  echo "[smoke-pdf] FAIL: universe create returned no id" >&2
  echo "$UNIV_RES" >&2
  exit 1
fi

# --- 3. create three entries (sequential — keep deterministic) -------------
create_entry() {
  local title="$1" type="$2"
  local body
  body=$(printf '{"title":"%s","type":"%s"}' "$title" "$type")
  curl -fsS -X POST "$API_BASE/universes/$UID_VAL/entries" \
    -H "Authorization: Bearer $TOKEN" \
    -H 'Content-Type: application/json' \
    -d "$body" >/dev/null
}

echo "[smoke-pdf] creating 3 entries"
create_entry 'Aragorn' 'character'
create_entry 'Mordor' 'location'
create_entry 'The One Ring' 'item'

# --- 4. export PDF ---------------------------------------------------------
echo "[smoke-pdf] requesting PDF export -> $PDF_OUT"
rm -f "$PDF_OUT"
curl -fsS -X POST "$API_BASE/universes/$UID_VAL/export?format=pdf" \
  -H "Authorization: Bearer $TOKEN" \
  -o "$PDF_OUT"

# --- 5. file shape assertions ---------------------------------------------
if [[ ! -s "$PDF_OUT" ]]; then
  echo "[smoke-pdf] FAIL: $PDF_OUT is empty or missing" >&2
  exit 1
fi
if ! head -c 4 "$PDF_OUT" | grep -q '%PDF'; then
  echo "[smoke-pdf] FAIL: $PDF_OUT does not start with %PDF magic bytes" >&2
  exit 1
fi

# --- 6. pdf-parse assertions on the host ----------------------------------
echo "[smoke-pdf] running pdf-parse from api/node_modules"
node -e "
  const fs = require('fs');
  const path = require('path');
  const pdfParse = require(path.join('$REPO_ROOT', 'api', 'node_modules', 'pdf-parse'));
  const buf = fs.readFileSync('$PDF_OUT');
  pdfParse(buf).then((d) => {
    if (d.numpages < 1) {
      console.error('[smoke-pdf] FAIL: numpages=' + d.numpages);
      process.exit(2);
    }
    if (!/Aragorn/.test(d.text)) {
      console.error('[smoke-pdf] FAIL: \"Aragorn\" not found in PDF text');
      process.exit(3);
    }
    console.log('[smoke-pdf] pdf-parse pages=' + d.numpages + ' textBytes=' + d.text.length);
  }).catch((err) => {
    console.error('[smoke-pdf] FAIL: pdf-parse threw: ' + err.message);
    process.exit(4);
  });
"

echo "[smoke-pdf] PASS"
