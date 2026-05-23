# syntax=docker/dockerfile:1.7

###############################################################################
# Stage 1: deps — install all workspace deps (cached most often)
###############################################################################
FROM node:22-bookworm-slim AS deps
WORKDIR /repo
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate
# `patch` is required by the root postinstall (scripts/apply-patches.sh) to
# apply patches/*.patch over node_modules. slim base does not include it.
RUN apt-get update && apt-get install -y --no-install-recommends patch && rm -rf /var/lib/apt/lists/*
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY api/package.json api/package.json
COPY web/package.json web/package.json
# Phase 21 added a root postinstall (sh scripts/apply-patches.sh) for the SDK
# patch. The script needs scripts/ and patches/ in the build context BEFORE
# pnpm install runs the postinstall hook.
COPY scripts ./scripts
COPY patches ./patches
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile

###############################################################################
# Stage 2: build — compile TS + Vite, then `pnpm deploy` for runtime artifact
###############################################################################
FROM deps AS build
COPY . .
RUN pnpm --filter api build:docker && pnpm --filter web build
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm deploy --filter @weltbon/api --prod /out/api

###############################################################################
# Stage 3: runtime — slim image with chromium + fonts + non-root user
###############################################################################
FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production \
    CHROMIUM_PATH=/usr/bin/chromium \
    PORT=3000

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

USER node
EXPOSE 3000

# Polls /health via Node's built-in fetch (Node 22 has it global). start_period
# gives migrations time to run on cold boot (RESEARCH Pitfall 9).
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

ENTRYPOINT ["dumb-init", "--"]
CMD ["./docker-entrypoint.sh"]
