#!/usr/bin/env sh
# docker-entrypoint.sh — runs drizzle migrations, then execs the API.
# Migration is idempotent via __drizzle_migrations table (RESEARCH Pattern 3).
# `exec` is critical so SIGTERM from `docker stop` reaches the node process directly.

set -e

echo "[entrypoint] Running database migrations..."
node dist/db/migrate.js

echo "[entrypoint] Starting Weltbon API on :${PORT:-3000}"
exec node dist/index.js
