#!/usr/bin/env bash
# check-runtime-config.sh — covers CONT-03b, CONT-03c, CONT-04a.
#
# Assertions (all inspection-only, no seeded user required):
#
#   CONT-03b  Non-root user:   `docker run --rm $IMAGE_TAG id -u` >= 1000
#   CONT-03c  HEALTHCHECK:     (a) image config has Healthcheck set
#                              (b) running `app` container reaches "healthy" within $HEALTH_TIMEOUT_SECONDS
#   CONT-04a  Postgres no port: (a) `docker compose port db 5432` prints nothing
#                               (b) `getent hosts db` resolves inside the app container
#
# Prerequisites:
#   - Image built and tagged $IMAGE_TAG (default weltbon:test)
#   - `docker compose up -d` already run by the caller
#
# Can be run standalone if both preconditions are met.
#
# Exit codes:
#   0  all assertions passed
#   1  one or more assertions failed (message on stderr)

set -euo pipefail

: "${IMAGE_TAG:=weltbon:test}"
: "${HEALTH_TIMEOUT_SECONDS:=90}"

# ---------------------------------------------------------------------------
# Guard: image must exist
# ---------------------------------------------------------------------------
if ! docker image inspect "$IMAGE_TAG" >/dev/null 2>&1; then
  echo "[check-runtime-config] FAIL: image '$IMAGE_TAG' not found locally — build first" >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# Guard: compose app + db containers must be running
# ---------------------------------------------------------------------------
APP_ID=$(docker compose ps -q app 2>/dev/null || true)
if [[ -z "$APP_ID" ]]; then
  echo "[check-runtime-config] FAIL: compose 'app' container not running — run 'docker compose up -d' first" >&2
  exit 1
fi

DB_ID=$(docker compose ps -q db 2>/dev/null || true)
if [[ -z "$DB_ID" ]]; then
  echo "[check-runtime-config] FAIL: compose 'db' container not running — run 'docker compose up -d' first" >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# CONT-03b — Non-root user (UID >= 1000)
# ---------------------------------------------------------------------------
echo "[check-runtime-config] CONT-03b: checking non-root UID..."

UID_VAL=$(docker run --rm "$IMAGE_TAG" id -u 2>/dev/null)

if [[ -z "$UID_VAL" || ! "$UID_VAL" =~ ^[0-9]+$ ]]; then
  echo "[check-runtime-config] FAIL (CONT-03b): 'docker run --rm $IMAGE_TAG id -u' returned unparseable value: '$UID_VAL'" >&2
  exit 1
fi

if [[ "$UID_VAL" -lt 1000 ]]; then
  echo "[check-runtime-config] FAIL (CONT-03b): image runs as UID $UID_VAL — expected >= 1000 (non-root). Remove or restore 'USER node' in Dockerfile." >&2
  exit 1
fi

echo "[check-runtime-config] CONT-03b PASS — UID=$UID_VAL (>= 1000, non-root)"

# ---------------------------------------------------------------------------
# CONT-03c-a — HEALTHCHECK declared in image config
# ---------------------------------------------------------------------------
echo "[check-runtime-config] CONT-03c-a: checking HEALTHCHECK declared in image..."

HC_RAW=$(docker image inspect "$IMAGE_TAG" --format '{{.Config.Healthcheck}}' 2>/dev/null)

if [[ -z "$HC_RAW" || "$HC_RAW" == "<no value>" ]]; then
  echo "[check-runtime-config] FAIL (CONT-03c-a): no HEALTHCHECK declared in image '$IMAGE_TAG'. Add a HEALTHCHECK instruction to Dockerfile." >&2
  exit 1
fi

echo "[check-runtime-config] CONT-03c-a PASS — Healthcheck config: $HC_RAW"

# ---------------------------------------------------------------------------
# CONT-03c-b — Running container reaches "healthy" within HEALTH_TIMEOUT_SECONDS
# ---------------------------------------------------------------------------
echo "[check-runtime-config] CONT-03c-b: waiting up to ${HEALTH_TIMEOUT_SECONDS}s for app container to become healthy..."

ELAPSED=0
HEALTH_STATUS=""
while [[ "$ELAPSED" -lt "$HEALTH_TIMEOUT_SECONDS" ]]; do
  HEALTH_STATUS=$(docker inspect "$APP_ID" --format '{{.State.Health.Status}}' 2>/dev/null || echo "inspect-error")
  if [[ "$HEALTH_STATUS" == "healthy" ]]; then
    break
  fi
  sleep 5
  ELAPSED=$(( ELAPSED + 5 ))
done

if [[ "$HEALTH_STATUS" != "healthy" ]]; then
  echo "[check-runtime-config] FAIL (CONT-03c-b): app container health status is '$HEALTH_STATUS' after ${ELAPSED}s — expected 'healthy' within ${HEALTH_TIMEOUT_SECONDS}s." >&2
  echo "[check-runtime-config]   Container ID: $APP_ID" >&2
  echo "[check-runtime-config]   Check 'docker inspect $APP_ID' and 'docker compose logs app' for details." >&2
  exit 1
fi

echo "[check-runtime-config] CONT-03c-b PASS — container healthy after ${ELAPSED}s"

# ---------------------------------------------------------------------------
# CONT-04a-a — Postgres has NO host port published
# ---------------------------------------------------------------------------
echo "[check-runtime-config] CONT-04a-a: checking Postgres has no host port mapping..."

# `docker compose port db 5432` prints "HOST:PORT" if mapped, or exits non-zero
# and prints nothing if not mapped. We want it to print nothing (or fail).
PORT_MAPPING=$(docker compose port db 5432 2>/dev/null || true)

if [[ -n "$PORT_MAPPING" ]]; then
  echo "[check-runtime-config] FAIL (CONT-04a-a): Postgres port 5432 is published to host as '$PORT_MAPPING'. Remove the 'ports:' block from the 'db' service in docker-compose.yml." >&2
  exit 1
fi

echo "[check-runtime-config] CONT-04a-a PASS — db:5432 has no host port mapping"

# ---------------------------------------------------------------------------
# CONT-04a-b — db service is reachable by name from inside app container
# ---------------------------------------------------------------------------
echo "[check-runtime-config] CONT-04a-b: checking 'db' hostname resolves inside app container..."

GETENT_OUT=$(docker compose exec -T app sh -c 'getent hosts db' 2>/dev/null || true)

if [[ -z "$GETENT_OUT" ]]; then
  echo "[check-runtime-config] FAIL (CONT-04a-b): 'getent hosts db' returned nothing inside the app container — 'db' service name is not resolvable. Check compose network configuration." >&2
  exit 1
fi

echo "[check-runtime-config] CONT-04a-b PASS — 'db' resolves inside app: $GETENT_OUT"

# ---------------------------------------------------------------------------
# All checks passed
# ---------------------------------------------------------------------------
echo "[check-runtime-config] PASS"
