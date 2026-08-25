#!/usr/bin/env bash
# Deploy a self-hosted Weltbon: pull, compile, restart, verify.
#
# WHY THIS EXISTS RATHER THAN "just run docker compose up -d --build".
# GET /api/version reports the running build's version and commit, and neither
# can be derived inside the container — the git history is never copied into the
# runtime stage. Compose cannot shell out to git either, so something has to
# compute them and put them in the environment. That something is this script.
#
# Run it from anywhere; it resolves the repo root itself.
#
#   ./scripts/deploy.sh                 # pull master, build, restart, verify
#   ./scripts/deploy.sh --no-pull       # build what is already checked out
#
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO"

PULL=1
for arg in "$@"; do
  case "$arg" in
    --no-pull) PULL=0 ;;
    *) echo "unknown argument: $arg" >&2; exit 2 ;;
  esac
done

# ── Back up before migrations run ────────────────────────────────────────────
# The container runs migrations at boot, so the restart below is the moment the
# schema changes. A dump costs seconds on a small instance and is the only thing
# standing between a bad migration and lost data.
if docker ps --format '{{.Names}}' | grep -qx weltbon-db-1; then
  mkdir -p "$HOME/weltbon-backups"
  BACKUP="$HOME/weltbon-backups/pre-deploy-$(date -u +%Y%m%dT%H%M%SZ).sql"
  docker exec weltbon-db-1 pg_dump -U weltbon -d weltbon > "$BACKUP"
  echo "[deploy] backup: $BACKUP ($(du -h "$BACKUP" | cut -f1))"
else
  echo "[deploy] no weltbon-db-1 container yet — skipping backup (first deploy?)"
fi

if [ "$PULL" -eq 1 ]; then
  git pull --ff-only origin master
fi

# ── Build identity ───────────────────────────────────────────────────────────
# `sed`, deliberately NOT `node -p`. On a deploy box where node came from nvm it
# is absent from a non-interactive ssh session, and `V=$(node -p ...)` inside an
# `&&` chain fails with `command not found` and short-circuits the whole deploy
# while still looking like it ran. That happened once; it is why this is sed.
WELTBON_VERSION="$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' package.json | head -1)"
WELTBON_COMMIT="$(git rev-parse --short HEAD)"
WELTBON_BUILT_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
export WELTBON_VERSION WELTBON_COMMIT WELTBON_BUILT_AT

if [ -n "$(git status --porcelain)" ]; then
  # Not fatal — a self-hoster may legitimately carry local config — but the
  # commit this stamps will not describe what actually got built.
  echo "[deploy] WARNING: working tree is dirty; ${WELTBON_COMMIT} will not fully describe this build"
fi

echo "[deploy] version=${WELTBON_VERSION} commit=${WELTBON_COMMIT} built=${WELTBON_BUILT_AT}"

docker compose build app
docker compose up -d app

# ── Verify ───────────────────────────────────────────────────────────────────
# Poll rather than sleep-and-hope: migrations run at boot and their duration is
# not fixed. A deploy that reports success without the app answering is how a
# broken release gets left running.
PORT="${WELTBON_PORT:-3000}"
echo "[deploy] waiting for the app to answer on :${PORT}"
for attempt in $(seq 1 30); do
  if REPORTED="$(curl -fsS --max-time 5 "http://127.0.0.1:${PORT}/api/version" 2>/dev/null)"; then
    echo "[deploy] up: ${REPORTED}"
    case "$REPORTED" in
      *"\"commit\":\"${WELTBON_COMMIT}\""*)
        echo "[deploy] OK — running commit matches what was just built"
        exit 0
        ;;
      *)
        echo "[deploy] WARNING: the app answered but reports a different build than the one just built." >&2
        echo "[deploy] Expected commit ${WELTBON_COMMIT}. A stale container may still be running." >&2
        exit 1
        ;;
    esac
  fi
  sleep 4
done

echo "[deploy] FAILED: no answer from /api/version after ~2 minutes." >&2
echo "[deploy] Check: docker compose logs --tail=50 app" >&2
exit 1
