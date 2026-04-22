# Weltbon

A self-hostable worldbuilding web app: create entries, link them with named relations, organize into categories, visualize as a graph, and export to multiple formats. Built for a close circle of worldbuilders -- not for SaaS scale.

**Current status: Phase 1 complete.** Authentication, universe CRUD, and self-host startup guards are in place. Entries, links, graph view, and exports are coming in Phases 2-5.

## Tech Stack

- **API**: Node.js 22 LTS, [Hono](https://hono.dev/) 4, [Drizzle ORM](https://orm.drizzle.team/) 0.45, PostgreSQL 16, [`jose`](https://github.com/panva/jose) v6 for JWT, [`bcrypt`](https://www.npmjs.com/package/bcrypt) v6 for passwords
- **Web**: React 19, Vite 8 (Rolldown), Tailwind CSS v4, TanStack Query 5, Zustand 5, React Router v7 (library mode), Radix UI primitives
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

Phase 1 registration is invite-code gated. Generate a code before you can register:

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

## Environment Variables

### Required

| Variable            | Purpose                                                      | Notes                                                                                |
|---------------------|--------------------------------------------------------------|--------------------------------------------------------------------------------------|
| `JWT_SECRET`        | HS256 signing key for access tokens (enforced at startup)    | Must be at least 32 characters. Generate with `openssl rand -hex 32`. Never commit.  |
| `DATABASE_URL`      | PostgreSQL connection string                                 | Must start with `postgresql://` or `postgres://`.                                    |
| `POSTGRES_PASSWORD` | Password for the postgres user in docker-compose             | Also referenced by `DATABASE_URL`.                                                   |

### Optional

| Variable         | Purpose                               | Default                                      |
|------------------|---------------------------------------|----------------------------------------------|
| `PORT`           | API listen port                       | `3000`                                       |
| `CHROMIUM_PATH`  | System Chromium binary for PDF export | Unused in Phase 1; required in Phase 3+.     |

### Startup Guard

The config guard lives in `api/src/config.ts`. It validates environment variables at process startup and refuses to start with a clear error if anything is wrong:

- **Missing `JWT_SECRET`**: `"JWT_SECRET must be set. Generate one with: openssl rand -hex 32"`
- **`JWT_SECRET` too short**: `"JWT_SECRET must be at least 32 characters (got N). Generate one with: openssl rand -hex 32"`
- **Missing `DATABASE_URL`**: `"DATABASE_URL must be set (expected postgresql:// URL)."`
- **Wrong `DATABASE_URL` scheme**: `"DATABASE_URL must start with postgresql:// or postgres://"`

This guard is covered by `api/tests/startup.test.ts`. See the "Verifying the Startup Guard" section below to test it manually.

## Admin / Operator Commands

Phase 1 has two CLI commands for operators. Both are run from the repo root.

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
│   │   ├── db/schema.ts             # users, universes, refresh_tokens, invite_codes
│   │   ├── middleware/auth.ts        # JWT verification middleware
│   │   ├── routes/auth.ts           # /auth/register, login, refresh, logout
│   │   ├── routes/universes.ts      # /universes CRUD with ownership enforcement
│   │   ├── services/auth.ts         # Token lifecycle, bcrypt, jose
│   │   └── scripts/
│   │       ├── invite-new.ts        # CLI: generate invite code
│   │       └── reset-password.ts    # CLI: reset user password
│   └── tests/
├── web/                       # React 19 + Vite 8 + Tailwind v4
│   └── src/
│       ├── api/client.ts            # Fetch wrapper, silent refresh on 401
│       ├── store/auth.ts            # Zustand: user + theme state
│       ├── hooks/
│       │   ├── useAuth.ts
│       │   └── useUniverse.ts
│       ├── components/              # Layout, UserMenu, ConfirmDialog, EmptyState
│       └── views/                   # Login, Register, UniverseList, UniverseSettings
├── docker-compose.yml         # PostgreSQL 16-alpine on 127.0.0.1:5432
├── .env.example               # Template for .env (never commit real .env)
└── README.md
```

## API Endpoints (Phase 1)

### Authentication

| Method | Path             | Body / Cookie                                  | Success           | Notes                                                  |
|--------|------------------|-------------------------------------------------|-------------------|--------------------------------------------------------|
| POST   | `/auth/register` | `{ email, password, displayName, inviteCode }` | 200 + refresh cookie | Invite code is consumed atomically                     |
| POST   | `/auth/login`    | `{ email, password }`                           | 200 + refresh cookie | 401 on mismatch; same message for wrong email or password (no user enumeration) |
| POST   | `/auth/refresh`  | httpOnly refresh cookie                         | 200 `{ accessToken }` + rotated cookie | Old refresh token revoked in same DB transaction       |
| POST   | `/auth/logout`   | httpOnly refresh cookie                         | 204               | Revokes only the current session's refresh token       |

### Universes (all require valid access token)

| Method | Path              | Body                              | Success     | Notes                              |
|--------|-------------------|-----------------------------------|-------------|------------------------------------|
| GET    | `/universes`      | --                                | 200         | Returns only the authenticated user's universes |
| POST   | `/universes`      | `{ name }`                        | 201         | Creates a universe owned by the authenticated user      |
| GET    | `/universes/:id`  | --                                | 200         | 404 if not found; 403 if cross-tenant                  |
| PATCH  | `/universes/:id`  | `{ name?, description? }`        | 200         | 403 if not owner                   |
| DELETE | `/universes/:id`  | --                                | 204         | 403 if not owner                   |

Cross-tenant access returns **403**. Nonexistent universe returns **404**. Unauthenticated requests return **401**.

## Security Posture (Phase 1)

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
| Refresh        | httpOnly cookie           | `refresh_tokens` table (bcrypt hash)      | 30 days | Rotated on every `/auth/refresh` call         |

- **Logout** revokes only the current session's refresh token. Other devices remain logged in.
- **Password reset** (CLI) revokes ALL refresh tokens for the user.
- **"Logout everywhere"** is not implemented in Phase 1.

## Production Deployment (Phase 1)

The target is a personal Linux server, not a cloud PaaS. Two processes: the API (bare Node) and PostgreSQL (docker-compose). The web app builds to static files served by nginx.

1. Clone the repo (e.g., under `/opt/weltbon/`).
2. Install dependencies: `pnpm install`.
3. Copy `.env.example` to `.env` and fill in a production `JWT_SECRET` and `POSTGRES_PASSWORD`.
4. Start the database: `docker compose up -d db`.
5. Apply migrations: `pnpm --filter api db:migrate`.
6. Build the API: `pnpm --filter api build` (produces `api/dist/`).
7. Build the web app: `pnpm --filter web build` (produces `web/dist/`).
8. Serve the API via systemd. Key command: `ExecStart=/usr/bin/node /opt/weltbon/api/dist/index.js`, with `EnvironmentFile=/opt/weltbon/.env`.
9. Serve `web/dist/` via nginx and proxy `/api/` to `http://127.0.0.1:3000/`.

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

Phase 1 test coverage: startup guard (6 assertions), auth endpoints (11 integration tests), universe CRUD with cross-tenant isolation (13 integration tests), web smoke tests (6 assertions across Login/Register/UniverseList).

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

## What's Next

- **Phase 2**: Entries, named links, backlinks, JSON export + import round-trip
- **Phase 3**: Categories, full-text search, force-directed graph view, issue tracker
- **Phase 4**: Markdown ZIP / PDF / DOCX exports
- **Phase 5**: Timeline view, meta fields UI, custom entry types, relation autocomplete, operational docs for Chromium + pg_dump backups

Full roadmap: project documentation.

## License

(To be chosen by the project owner. No license is declared in Phase 1.)
