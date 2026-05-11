# Weltbon

A self-hostable worldbuilding web app: create entries, link them with named relations, organize into categories, visualize as a graph, and export to multiple formats. Built for a close circle of worldbuilders -- not for SaaS scale.

**Status:** v1 ready. All 65 v1 requirements implemented across 5 phases. Self-host friendly.

## Contents

- [Quickstart (Development)](#quickstart-development)
- [Self-Host (Docker)](#self-host-docker)
- [Self-Host (Bare Node)](#self-host-bare-node)
- [Backup](#backup)
- [Environment Variables](#environment-variables)
- [Admin / Operator Commands](#admin--operator-commands)
- [Tech Stack](#tech-stack)
- [Architecture at a Glance](#architecture-at-a-glance)
- [Security Posture](#security-posture)
- [Running Tests](#running-tests)

## Tech Stack

- **API**: Node.js 22 LTS, [Hono](https://hono.dev/) 4, [Drizzle ORM](https://orm.drizzle.team/) 0.45, PostgreSQL 16, [`jose`](https://github.com/panva/jose) v6 for JWT, [`bcrypt`](https://www.npmjs.com/package/bcrypt) v6 for passwords, [`puppeteer-core`](https://pptr.dev/) for PDF export, [`docx`](https://docx.js.org/) for DOCX export, [`archiver`](https://www.archiverjs.com/) for Markdown ZIP export
- **Web**: React 19, Vite 8 (Rolldown), Tailwind CSS v4, TanStack Query 5, Zustand 5, React Router v7 (library mode), Radix UI primitives, d3-force for graph view
- **Deployment**: bare Node processes for API and web build; PostgreSQL in docker-compose; LAN-only posture

Full package list and versions: see `api/package.json` and `web/package.json`.

## Quickstart (Development)

Prerequisites: Node.js 22+, pnpm 9+, Docker (for PostgreSQL), openssl (for generating JWT_SECRET).

### 1. Clone and install dependencies

```bash
git clone <your-remote> weltbon && cd weltbon
pnpm install
```

### 2. Create `.env` from the template

```bash
cp .env.example .env
```

### 3. Generate a JWT secret and paste it into `.env`

The JWT secret **must be at least 32 characters**; the API refuses to start otherwise.

```bash
openssl rand -hex 32
```

Put the output as `JWT_SECRET=<output>` in `.env`. Set `POSTGRES_PASSWORD` to something you will remember. The default `DATABASE_URL` in the template already uses `weltbon` as the password -- if you change `POSTGRES_PASSWORD`, update `DATABASE_URL` to match.

### 4. Start PostgreSQL

```bash
docker compose up -d db
```

This runs `postgres:16-alpine` bound to `127.0.0.1:5432` only (not reachable from the LAN unless explicitly exposed). Verify with:

```bash
docker compose ps
```

### 5. Apply database migrations

```bash
pnpm --filter api db:migrate
```

### 6. Create your first invite code

Registration is invite-code gated. Generate a code before you can register:

```bash
pnpm --filter api invite:new
```

Share the printed code with yourself (or the user you are inviting). Codes are single-use and consumed on registration.

### 7. Start the API (terminal 1)

```bash
pnpm --filter api dev
```

Listens on `http://127.0.0.1:3000` by default (configurable via `PORT`).

### 8. Start the web dev server (terminal 2)

```bash
pnpm --filter web dev
```

Opens `http://localhost:5173`. All `/api/*` requests are proxied to the API automatically.

### 9. Register

Visit `/register`, enter your email, a password (minimum 12 characters), a display name, and the invite code from step 6. Submit to create your account and land on the universe list.

## Self-Host (Docker)

Pull the published image, configure `.env`, run `docker compose up -d`.

### Prerequisites

- Docker Engine 24+
- Docker Compose v2 (the `docker compose` plugin, not the legacy `docker-compose` binary)
- An open host port (3000 by default; change via `PORT`)
- Optional: a reverse proxy for production — see [docs/reverse-proxy/](docs/reverse-proxy/)

### Environment Variables

Every variable from `.env.example`. Replace `<owner>` with the GitHub user or org publishing the image (e.g., `ghcr.io/<owner>/weltbon:latest`).

| Variable | Required | Purpose | How to generate |
|----------|----------|---------|-----------------|
| `JWT_SECRET` | yes | HS256 signing key for access tokens; the API refuses to boot if missing or shorter than 32 characters | `openssl rand -hex 32` |
| `POSTGRES_PASSWORD` | yes | Password for the `db` service in `docker-compose.yml`; also embedded in `DATABASE_URL` | Any strong secret; `openssl rand -base64 24` works |
| `DATABASE_URL` | yes | Postgres connection string for the API | Templated as `postgresql://weltbon:${POSTGRES_PASSWORD}@db:5432/weltbon` |
| `INVITE_CODE` | first boot only | Seeds the `invite_codes` table on cold start if the table is empty; required only for the first registration | Any string; can be removed from `.env` after the first user account exists |
| `PORT` | no | API listen port inside the container | Default: `3000` |
| `CHROMIUM_PATH` | no | System Chromium binary for PDF export | Container ships `/usr/bin/chromium` and sets this automatically; only set for bare-Node runs — see [Self-Host (Bare Node)](#self-host-bare-node) |
| `WELTBON_PUBLIC_ORIGIN` | no | Public origin for CORS allow-list when behind a reverse proxy (e.g., `https://welt.example.com`); absent keeps dev-friendly permissive CORS | The operator's external origin — see [docs/reverse-proxy/](docs/reverse-proxy/) |

### Quickstart

```bash
mkdir weltbon && cd weltbon
curl -O https://raw.githubusercontent.com/<owner>/weltbon/v2.1/docker-compose.yml
curl -O https://raw.githubusercontent.com/<owner>/weltbon/v2.1/.env.example
mv .env.example .env
# Edit .env: set JWT_SECRET, POSTGRES_PASSWORD, INVITE_CODE
# Edit docker-compose.yml: uncomment the `image:` line (ghcr.io/<owner>/weltbon:latest), remove (or comment) `build: .`
docker compose up -d
docker compose logs -f app
```

### Verifying

```bash
curl http://localhost:3000/health
# Expected: {"ok":true}
```

Then open `http://localhost:3000/register` in a browser and register the first account using `INVITE_CODE`.

### Updating

```bash
docker compose pull
docker compose up -d
```

### Where to next

- Production behind a reverse proxy: [docs/reverse-proxy/](docs/reverse-proxy/)
- Backups: [Backup](#backup)
- Running without Docker: [Self-Host (Bare Node)](#self-host-bare-node)
- PDF export still failing after install: [Troubleshooting](#troubleshooting)

## Self-Host

PDF export uses `puppeteer-core` against system Chromium. You must install Chromium and point `CHROMIUM_PATH` at the binary. If PDF export returns a 500 with `Failed to launch the browser process` or `ENOENT`, it is almost always a wrong `CHROMIUM_PATH`.

### Debian (Bookworm / Trixie)

```bash
sudo apt install chromium
# Then in your .env:
CHROMIUM_PATH=/usr/bin/chromium
```

Note: on Debian the package is `chromium`, **not** `chromium-browser`. The latter only exists on Ubuntu and is a Snap wrapper that breaks `puppeteer-core`.

### Ubuntu (22.04+)

Ubuntu's `apt install chromium-browser` is a transitional Snap wrapper. Snap's sandbox confinement frequently breaks `puppeteer-core`'s launch path with cryptic crashes.

**Recommended** -- install the native `.deb` from the xtradeb PPA:

```bash
sudo add-apt-repository ppa:xtradeb/apps
sudo apt update
sudo apt install chromium
# Then in your .env:
CHROMIUM_PATH=/usr/bin/chromium
```

**Or** accept the Snap path (fragile -- expect launch failures under load):

```bash
sudo apt install chromium-browser
# Then in your .env:
CHROMIUM_PATH=/snap/bin/chromium
```

### macOS

```bash
brew install --cask chromium
# Then in your .env:
CHROMIUM_PATH=/Applications/Chromium.app/Contents/MacOS/Chromium
```

### Verifying

After installing and setting `CHROMIUM_PATH`, restart the API process and trigger a PDF export from the entry list. If you get `Failed to launch the browser process` or `ENOENT`, the path is wrong -- run `which chromium` (Linux) or `ls /Applications/Chromium.app/Contents/MacOS/` (macOS) and update `.env`.

## Backup

Postgres lives in `docker compose`'s `db` service. Use `pg_dump` for backups and a cron line for automation. We don't ship retention -- rotate manually if you care; disk is cheap.

### Recommended cron line (docker compose)

Install with `crontab -e` and paste:

```cron
0 3 * * * docker compose -f /opt/weltbon/docker-compose.yml exec -T db pg_dump -U weltbon weltbon | gzip > /backups/weltbon-$(date +\%F).sql.gz
```

The `\%F` escape is required. Bare `%` in a crontab is interpreted as a newline / stdin separator and your backup file silently ends up named `weltbon-.sql.gz` (every run overwrites the previous one). Adjust the `-f` path to your `docker-compose.yml` location and `/backups/` to your preferred directory (which must exist and be writable by the user owning the crontab).

### Host-installed Postgres alternative

If you run Postgres directly on the host (not in docker compose), use the bare form instead:

```cron
0 3 * * * pg_dump weltbon | gzip > /backups/weltbon-$(date +\%F).sql.gz
```

After installing, verify with `crontab -l` -- the listed line should contain `\%F` literally (backslash visible). If the backslash is gone, your editor stripped it; reinstall with `crontab -e` and paste again.

### What to back up

- **The `pg_dump` output** -- produced by the cron line above. This is the portable, restorable artifact; you do not also need to back up the `pgdata` Docker volume (the SQL dump captures everything).
- **`.env`** -- losing `JWT_SECRET` invalidates every active session and refresh token; losing `POSTGRES_PASSWORD` breaks `DATABASE_URL`. Back up `.env` to an encrypted store (a password manager works) -- do NOT commit it.

### Restore

```bash
gunzip -c /backups/weltbon-2026-04-23.sql.gz | psql weltbon
# Or via docker compose:
gunzip -c /backups/weltbon-2026-04-23.sql.gz | docker compose exec -T db psql -U weltbon weltbon
```

### Rotation

We deliberately ship no retention logic. Delete files older than N days however you like:

```bash
find /backups -name 'weltbon-*.sql.gz' -mtime +30 -delete
```

### What NOT to commit

Keep these out of git regardless of where you back them up:

- `.env` -- contains `JWT_SECRET` and `POSTGRES_PASSWORD`. The committed template is `.env.example`.
- The `/backups/` directory (or wherever your cron writes) -- contains user data and Postgres internals.
- Any TLS certificates or private keys you place in the repo for the reverse proxy (see [docs/reverse-proxy/](docs/reverse-proxy/)).

## Environment Variables

### Required

| Variable            | Purpose                                                      | Notes                                                                                |
|---------------------|--------------------------------------------------------------|--------------------------------------------------------------------------------------|
| `JWT_SECRET`        | HS256 signing key for access tokens (enforced at startup)    | Must be at least 32 characters. Generate with `openssl rand -hex 32`. Never commit.  |
| `DATABASE_URL`      | PostgreSQL connection string                                 | Must start with `postgresql://` or `postgres://`.                                    |
| `POSTGRES_PASSWORD` | Password for the postgres user in docker-compose             | Also referenced by `DATABASE_URL`.                                                   |

### Optional

| Variable         | Purpose                                                            | Default                                      |
|------------------|--------------------------------------------------------------------|----------------------------------------------|
| `PORT`           | API listen port                                                    | `3000`                                       |
| `CHROMIUM_PATH`  | System Chromium binary path for PDF export (`puppeteer-core`)      | unset; PDF export 503s without it. See [Self-Host](#self-host) for per-OS values. |

### Startup Guard

The config guard lives in `api/src/config.ts`. It validates environment variables at process startup and refuses to start with a clear error if anything is wrong:

- **Missing `JWT_SECRET`**: `"JWT_SECRET must be set. Generate one with: openssl rand -hex 32"`
- **`JWT_SECRET` too short**: `"JWT_SECRET must be at least 32 characters (got N). Generate one with: openssl rand -hex 32"`
- **Missing `DATABASE_URL`**: `"DATABASE_URL must be set (expected postgresql:// URL)."`
- **Wrong `DATABASE_URL` scheme**: `"DATABASE_URL must start with postgresql:// or postgres://"`

This guard is covered by `api/tests/startup.test.ts`. See the "Verifying the Startup Guard" section below to test it manually.

## Admin / Operator Commands

Two CLI commands for operators. Both run from the repo root.

### Issue a New Invite Code

```bash
pnpm --filter api invite:new
```

Prints a random base64url invite code (16 characters) and stores it in the `invite_codes` table. Single-use: the code is consumed atomically on registration. No expiry -- delete manually from the database if you need to revoke an unused code.

### Reset a User's Password

```bash
pnpm --filter api user:reset-password <email> <new_password>
```

Hashes the new password (bcrypt cost 12), updates `users.password_hash`, and **revokes ALL active refresh tokens** for that user. Minimum password length: 12 characters.

**Note on access token validity:** Stateless access tokens (JWT) remain valid for up to 1 hour after a password reset. Any refresh attempt after the reset will fail, forcing the user to log in with the new password. For a trusted-circle deployment this is acceptable and documented behavior.

**No SMTP / no email-based reset:** There is no email verification and no email-based password reset flow. Password resets are operator-only via the CLI.

## Architecture at a Glance

```
weltbon/
├── api/                       # Hono + Drizzle + PostgreSQL
│   ├── src/
│   │   ├── config.ts                # Startup env guard (OPS-04)
│   │   ├── db/schema.ts             # users, universes, entries, links, categories, issues, graph_positions, refresh_tokens, invite_codes
│   │   ├── middleware/auth.ts       # JWT verification middleware
│   │   ├── routes/                  # auth, universes, entries, links, categories, issues, graph, export, import
│   │   ├── services/
│   │   │   ├── auth.ts              # Token lifecycle, bcrypt, jose
│   │   │   └── export/              # markdown-zip, pdf, docx, json exporters
│   │   └── scripts/
│   │       ├── invite-new.ts        # CLI: generate invite code
│   │       └── reset-password.ts    # CLI: reset user password
│   └── tests/
├── web/                       # React 19 + Vite 8 + Tailwind v4
│   └── src/
│       ├── api/client.ts            # Fetch wrapper, silent refresh on 401
│       ├── store/auth.ts            # Zustand: user + theme state
│       ├── hooks/                   # useAuth, useUniverse, useEntries, useLinks, useGraph, ...
│       ├── components/              # Layout, ExportMenu, GraphCanvas, LinkEditor, ImportDialog, ...
│       └── views/                   # Login, Register, UniverseList, EntryList, EntryDetail, GraphView, ...
├── docker-compose.yml         # PostgreSQL 16-alpine on 127.0.0.1:5432
├── .env.example               # Template for .env (never commit real .env)
└── README.md
```

## Security Posture

- **Passwords**: bcrypt cost 12. Async hashing only (no `hashSync` / `compareSync`).
- **Access tokens**: HS256 JWT signed via `jose`. Every `jwtVerify` call pins `algorithms: ['HS256']` to prevent algorithm confusion. TTL: 1 hour. Held in memory on the client -- never in localStorage.
- **Refresh tokens**: random 256-bit opaque strings, bcrypt-hashed in the `refresh_tokens` table. TTL: 30 days. Stored client-side as an `HttpOnly; SameSite=Strict; Path=/auth` cookie. Rotated on every refresh; old token revoked in the same DB transaction that issues the new one.
- **Universe ownership**: enforced inline on every `/universes/:id` route. Cross-tenant access returns 403; nonexistent universe returns 404.
- **Registration**: invite-code gated. Codes are single-use, atomically consumed via a conditional UPDATE. Admin CLI issues new codes.
- **No SMTP**: no email verification, no email-based password reset. Password reset is operator-only via CLI.
- **LAN deployment assumed**: the refresh cookie does NOT include `Secure`, so it works over HTTP on a LAN. For any internet-facing deployment, put the API behind TLS and set `Secure` on the refresh cookie.
- **PostgreSQL bind**: docker-compose binds to `127.0.0.1:5432` only. Do not expose port 5432 to the LAN.
- **Authorization header / cookie stripping**: error handlers do not log `Authorization` or `Cookie` headers to prevent token leakage in logs.

## Session Lifecycle

| Token          | Storage (client)         | Storage (server)                          | TTL     | Rotation                                      |
|----------------|--------------------------|-------------------------------------------|---------|-----------------------------------------------|
| Access (JWT)   | In-memory only           | Stateless (verified by signature)         | 1 hour  | Issued on login, register, and refresh        |
| Refresh        | httpOnly cookie          | `refresh_tokens` table (bcrypt hash)      | 30 days | Rotated on every `/auth/refresh` call         |

- **Logout** revokes only the current session's refresh token. Other devices remain logged in.
- **Password reset** (CLI) revokes ALL refresh tokens for the user.
- **"Logout everywhere"** is not implemented.

## Production Deployment

The target is a personal Linux server, not a cloud PaaS. Two processes: the API (bare Node) and PostgreSQL (docker-compose). The web app builds to static files served by nginx.

1. Clone the repo (e.g., under `/opt/weltbon/`).
2. Install dependencies: `pnpm install`.
3. Copy `.env.example` to `.env` and fill in a production `JWT_SECRET`, `POSTGRES_PASSWORD`, and `CHROMIUM_PATH` (see [Self-Host](#self-host)).
4. Start the database: `docker compose up -d db`.
5. Apply migrations: `pnpm --filter api db:migrate`.
6. Build the API: `pnpm --filter api build` (produces `api/dist/`).
7. Build the web app: `pnpm --filter web build` (produces `web/dist/`).
8. Serve the API via systemd. Key command: `ExecStart=/usr/bin/node /opt/weltbon/api/dist/index.js`, with `EnvironmentFile=/opt/weltbon/.env`.
9. Serve `web/dist/` via nginx and proxy `/api/` to `http://127.0.0.1:3000/`.
10. Install the [Backup](#backup) cron line.

Example nginx snippet:

```nginx
server {
    listen 80;
    server_name weltbon.local;

    root /opt/weltbon/web/dist;
    index index.html;

    location /api/ {
        proxy_pass http://127.0.0.1:3000/;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }

    location / {
        try_files $uri $uri/ /index.html;
    }
}
```

## Running Tests

```bash
# API integration tests (requires docker compose up -d db)
pnpm --filter api test -- --run

# Web smoke tests (jsdom, no DB required)
pnpm --filter web test -- --run
```

## Verifying the Startup Guard

A deliberate foot-gun check: start the API without `JWT_SECRET`. It must exit non-zero.

```bash
unset JWT_SECRET && pnpm --filter api dev
# Expected: "Error: JWT_SECRET must be set. Generate one with: openssl rand -hex 32"
# Process exits with non-zero status.
```

And with a too-short secret:

```bash
JWT_SECRET=too-short DATABASE_URL=postgresql://x pnpm --filter api dev
# Expected: "Error: JWT_SECRET must be at least 32 characters (got 9). ..."
```

This is the manual smoke test for OPS-04: the application must refuse to start with invalid configuration.

## License

(To be chosen by the project owner. No license is declared in v1.)
