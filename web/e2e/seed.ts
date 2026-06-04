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
const DB_CONTAINER = 'weltbon-db-1';

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
 * weltbon-db-1 publishes no host port, so reach it on the docker bridge IP
 * (see the weltbon-test-commands project note). Overridable via WELTBON_DB_HOST.
 */
export function resolveDbHost(): string {
  if (process.env.WELTBON_DB_HOST) return process.env.WELTBON_DB_HOST;
  const ip = sh(
    `docker inspect ${DB_CONTAINER} --format '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}'`,
  );
  if (!ip) {
    throw new Error(
      `Could not resolve ${DB_CONTAINER} bridge IP. Is the stack up? Run: docker compose up -d --build`,
    );
  }
  return ip;
}

export function psql(dbHost: string, query: string, opts: { quiet?: boolean } = {}) {
  return execSync(
    `PGPASSWORD=${PG_PASSWORD} psql -h ${dbHost} -U ${PG_USER} -d ${PG_DB} -tAc ${JSON.stringify(query)}`,
    { encoding: 'utf8', stdio: opts.quiet ? 'ignore' : 'pipe' },
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
