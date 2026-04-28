#!/usr/bin/env bash
# check-size.sh — covers CONT-03a.
#
# Asserts the built image is under the 600 MB Phase 6 budget.
# Image tag is read from $IMAGE_TAG (default weltbon:test).

set -euo pipefail

: "${IMAGE_TAG:=weltbon:test}"
: "${SIZE_BUDGET_BYTES:=600000000}"

if ! docker image inspect "$IMAGE_TAG" >/dev/null 2>&1; then
  echo "[check-size] FAIL: image '$IMAGE_TAG' not found locally — build first" >&2
  exit 1
fi

SIZE=$(docker image inspect "$IMAGE_TAG" --format '{{.Size}}')
if [[ -z "$SIZE" || ! "$SIZE" =~ ^[0-9]+$ ]]; then
  echo "[check-size] FAIL: docker inspect returned unparseable size '$SIZE'" >&2
  exit 1
fi

MB=$(( SIZE / 1000000 ))
BUDGET_MB=$(( SIZE_BUDGET_BYTES / 1000000 ))

if [[ "$SIZE" -ge "$SIZE_BUDGET_BYTES" ]]; then
  echo "[check-size] FAIL: image size ${MB} MB exceeds ${BUDGET_MB} MB budget (raw bytes: $SIZE)" >&2
  exit 1
fi

echo "[check-size] PASS — ${MB} MB / ${BUDGET_MB} MB budget"
