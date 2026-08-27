import { execSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SEED_FILE = resolve(
  dirname(fileURLToPath(import.meta.url)),
  'seed.json',
);

export const API = 'http://localhost:3000/api';
const PG_PASSWORD = 'weltbon';
const PG_USER = 'weltbon';
const PG_DB = 'weltbon';
const DB_SERVICE = 'db';
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const COMPOSE_FILE = resolve(REPO_ROOT, 'docker-compose.yml');

export interface Seed {
  uid: string;
  mainId: string;
  targetId: string;
  langId: string;
  shareToken: string;
  shareUrl: string;
  /** Owner JWT — used by teardown to DELETE the universe. */
  ownerToken: string;
  userId: string;
  email: string;
  /** Postgres bridge IP resolved at setup — reused by teardown. */
  dbHost: string;
}

function sh(cmd: string): string {
  return execSync(cmd, { encoding: 'utf8' }).trim();
}

/**
 * The database publishes no host port, so resolve the active Compose `db`
 * service to its bridge IP (see the weltbon-test-commands project note).
 * Overridable via WELTBON_DB_HOST.
 */
export function resolveDbHost(): string {
  if (process.env.WELTBON_DB_HOST) return process.env.WELTBON_DB_HOST;
  const dbContainer = resolveDbContainer();
  const ip = sh(
    `docker inspect ${dbContainer} --format '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}'`,
  );
  if (!ip) {
    throw new Error(
      `Could not resolve the ${DB_SERVICE} service bridge IP. Is the stack up? Run: docker compose up -d --build`,
    );
  }
  return ip;
}

function resolveDbContainer(): string {
  const dbContainer = sh(`docker compose -f ${JSON.stringify(COMPOSE_FILE)} ps -q ${DB_SERVICE}`);
  if (!dbContainer) {
    throw new Error(
      `Could not resolve the ${DB_SERVICE} service container. Is the stack up? Run: docker compose up -d --build`,
    );
  }
  return dbContainer;
}

function hostPsqlAvailable(): boolean {
  try {
    execSync('command -v psql', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

export function psql(dbHost: string, query: string, opts: { quiet?: boolean } = {}) {
  const stdio = opts.quiet ? 'ignore' : 'pipe';
  if (process.env.WELTBON_DB_HOST || hostPsqlAvailable()) {
    return execSync(
      `PGPASSWORD=${PG_PASSWORD} psql -h ${dbHost} -U ${PG_USER} -d ${PG_DB} -tAc ${JSON.stringify(query)}`,
      { encoding: 'utf8', stdio },
    );
  }

  // The standard Postgres image includes psql, while the Node host image does
  // not. Use the active Compose service as the fallback so isolated worktrees
  // do not depend on a hard-coded project/container name or host packages.
  const dbContainer = resolveDbContainer();
  return execSync(
    `docker exec ${dbContainer} psql -U ${PG_USER} -d ${PG_DB} -tAc ${JSON.stringify(query)}`,
    { encoding: 'utf8', stdio },
  );
}

export async function api(
  token: string | null,
  method: string,
  path: string,
  body?: unknown,
): Promise<any> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(API + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`${method} ${path} → ${res.status} ${text.slice(0, 300)}`);
  }
  return text ? JSON.parse(text) : null;
}

/** The fictional calendar used by the calendar/timeline assertions. */
export const E2E_CALENDAR = {
  eras: [{ name: 'Third Era', abbr: 'TE', startPosition: 0 }],
  beforeEraAbbr: 'BE',
  months: [
    { name: 'Frostmoon', lengthDays: 30 },
    { name: 'Thawmoon', lengthDays: 30 },
    { name: 'Bloommoon', lengthDays: 31 },
    { name: 'Suntide', lengthDays: 31 },
    { name: 'Highsun', lengthDays: 31 },
    { name: 'Harvestmoon', lengthDays: 30 },
    { name: 'Dimmoon', lengthDays: 30 },
    { name: 'Frostfall', lengthDays: 30 },
  ],
  weekdays: ['Sunday', 'Moonday', 'Fireday', 'Waterday', 'Woodday', 'Goldday', 'Starday'],
  moons: [{ name: 'Pale Sister', cycleDays: 29 }],
};

/** Pin position chosen so the calendar renderer yields "14 Frostmoon, 413 TE". */
export const E2E_PIN_POSITION = 100129;
