# syntax=docker/dockerfile:1.7

###############################################################################
# Stage 1: deps — install all workspace deps (cached most often)
###############################################################################
FROM node:22-bookworm-slim AS deps
WORKDIR /repo
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY api/package.json api/package.json
COPY web/package.json web/package.json
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile

###############################################################################
# Stage 2: build — compile TS + Vite, then `pnpm deploy` for runtime artifact
###############################################################################
FROM deps AS build
COPY . .

# ── WHY THE HEAP BUMP AND THE ASSERTION ──────────────────────────────────────
# `build:docker` is `tsc -p tsconfig.build.json || true`. The `|| true` is there
# because this project has a documented non-zero type-error baseline and the
# emitted JS is correct anyway — but it also swallows a *crash*, and tsc crashed.
#
# On the GitHub runner tsc exhausted Node's default ~2 GB heap:
#
#   FATAL ERROR: Ineffective mark-compacts near heap limit
#   Allocation failed - JavaScript heap out of memory
#
# `|| true` turned that into a silent success. The stage reported DONE, `pnpm
# deploy` cheerfully copied a package with no `dist/`, and the build died two
# stages later as `"/out/api/dist": not found` — an error naming neither tsc nor
# memory. desktop/scripts/stage-api.sh already carries a note about CI heap
# exhaustion from typechecking; this is the same failure in the image build.
#
# The heap bump raises the ceiling. The assertion is the more important half:
# it makes any future no-emit fail HERE, naming the stage that actually broke,
# instead of surfacing as a missing path in an unrelated COPY.
RUN NODE_OPTIONS=--max-old-space-size=4096 pnpm --filter api build:docker \
    && pnpm --filter web build \
    && { test -s api/dist/index.js || { \
         echo "FATAL: tsc produced no api/dist/index.js. build:docker swallows tsc's exit code (|| true), so this is what a tsc CRASH looks like — check the output above for 'heap out of memory'." >&2; \
         exit 1; \
       }; }
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm deploy --filter @weltbon/api --prod /out/api

###############################################################################
# Stage 3: runtime — slim image with chromium + fonts + non-root user
###############################################################################
FROM node:22-bookworm-slim AS runtime

# Build identity, surfaced by GET /api/version.
#
# ARGs rather than a file baked into the image: the values differ per build but
# nothing else in the layer does, and declaring them here keeps the expensive
# apt layer below cache-stable across releases. publish-ghcr.yml passes the
# release tag and commit; a plain `docker compose build` leaves them empty and
# the API falls back to api/package.json, which is correct for a local build.
ARG WELTBON_VERSION=""
ARG WELTBON_COMMIT=""
ARG WELTBON_BUILT_AT=""

ENV NODE_ENV=production \
    CHROMIUM_PATH=/usr/bin/chromium \
    PORT=3000 \
    WELTBON_VERSION=$WELTBON_VERSION \
    WELTBON_COMMIT=$WELTBON_COMMIT \
    WELTBON_BUILT_AT=$WELTBON_BUILT_AT

# System Chromium + Noto/Liberation fonts + dumb-init for PID 1 signal handling.
# fc-cache refreshes the fontconfig cache so Chromium picks up the new fonts.
# /var/lib/apt/lists removal trims ~40 MB.
RUN apt-get update && apt-get install -y --no-install-recommends \
        chromium \
        fonts-noto-core \
        fonts-noto-color-emoji \
        fonts-liberation \
        ca-certificates \
        dumb-init \
    && fc-cache -fv \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# /out/api from stage 2 is a self-contained, hoisted node_modules with prod-only deps.
COPY --from=build --chown=node:node /out/api/dist           ./dist
COPY --from=build --chown=node:node /out/api/node_modules   ./node_modules
COPY --from=build --chown=node:node /out/api/package.json   ./package.json
# Migrations folder — drizzle reads SQL files from ./drizzle relative to cwd
COPY --from=build --chown=node:node /repo/api/drizzle       ./drizzle
# Font woff2 files for the PDF exporter (fonts.ts resolves ../../../../assets/fonts
# from /app/dist/services/export/pdf/, which lands on /app/assets/fonts/)
COPY --from=build --chown=node:node /repo/api/assets        ./assets
# Built web SPA — 06-03 wires Hono serveStatic({ root: './web-dist' })
COPY --from=build --chown=node:node /repo/web/dist          ./web-dist
# Entrypoint shell that runs migrations then execs the API
COPY --chown=node:node docker-entrypoint.sh                 ./docker-entrypoint.sh
RUN chmod +x ./docker-entrypoint.sh

# `node` BEFORE declaring USER node so the docker-compose `uploads:/uploads`
# named volume inherits node:node on first mount. Without this the fresh volume
# is created root:root and the non-root `node` process gets EACCES writing
RUN mkdir -p /uploads && chown node:node /uploads

USER node
EXPOSE 3000

# Polls /health via Node's built-in fetch (Node 22 has it global). start_period
# gives migrations time to run on cold boot (RESEARCH Pitfall 9).
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

ENTRYPOINT ["dumb-init", "--"]
CMD ["./docker-entrypoint.sh"]
