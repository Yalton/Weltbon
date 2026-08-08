// api/src/config.ts
export type DbDriver = 'postgres' | 'pglite';

export interface Env {
  jwtSecret: Uint8Array;
  dbDriver: DbDriver;
  /** Undefined when dbDriver === 'pglite'. */
  databaseUrl: string | undefined;
  /** The PGlite data directory. Required when dbDriver === 'pglite', else undefined. */
  dataDir: string | undefined;
  chromiumPath: string | undefined;
  publicOrigin: string | undefined;
  port: number;
  /** Directory holding the built SPA. Relative paths resolve against process.cwd(). */
  webDist: string;
  llmKeyEncryptionKey: string | undefined;
  // Phase 24 AUDIT hard caps (T-24-01-03: validated at boot, defaults applied when unset).
  auditMaxToolCalls: number;     // AUDIT_MAX_TOOL_CALLS, default 20
  auditMaxWallClockMs: number;   // AUDIT_MAX_WALL_CLOCK_MS, default 120_000
  auditMaxCostUsd: number;       // AUDIT_MAX_COST_USD, default 1.00
  auditMaxTokensTotal: number;   // AUDIT_MAX_TOKENS_TOTAL, default 200_000
  auditShutdownGraceMs: number;  // AUDIT_SHUTDOWN_GRACE_MS, default 15_000
  /** DV-11: local desktop mode. Enables the credential-free local session route. */
  localMode: boolean;
  /**
   * Host/interface `serve()` binds to. Leaving this undefined preserves the
   * pre-existing all-interfaces default (`@hono/node-server` passes it
   * straight through to `net.Server#listen`, and `hostname: undefined`
   * behaves exactly like omitting the option) — the Docker container needs
   * that so its published port is reachable from the host. The desktop app
   * sets this to '127.0.0.1': it mints credential-free local sessions and
   * must never be reachable from the LAN.
   */
  bindHost: string | undefined;
}

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const jwt = source.JWT_SECRET;

  if (!jwt) {
    throw new Error(
      'JWT_SECRET must be set. Generate one with: openssl rand -hex 32'
    );
  }
  if (jwt.length < 32) {
    throw new Error(
      `JWT_SECRET must be at least 32 characters (got ${jwt.length}). Generate one with: openssl rand -hex 32`
    );
  }

  // ── DV-03: which database engine backs this process ────────────────────────
  // Default 'postgres' is load-bearing: the Docker stack, CI, the sync rig and
  // the temp prod all omit this variable and must keep the pre-DV-03 behaviour.
  const rawDriver = source.WELTBON_DB_DRIVER ?? 'postgres';
  if (rawDriver !== 'postgres' && rawDriver !== 'pglite') {
    throw new Error(
      `WELTBON_DB_DRIVER must be "postgres" or "pglite" (got "${rawDriver}").`
    );
  }
  const dbDriver: DbDriver = rawDriver;

  const db = source.DATABASE_URL;
  const dataDir = source.WELTBON_DATA_DIR;

  if (dbDriver === 'postgres' && !db) {
    throw new Error('DATABASE_URL must be set (expected postgresql:// URL).');
  }
  if (dbDriver === 'pglite' && !dataDir) {
    throw new Error(
      'WELTBON_DATA_DIR must be set when WELTBON_DB_DRIVER=pglite ' +
      '(the directory PGlite stores its data in).'
    );
  }
  // Validate the URL's shape whenever one is present, regardless of driver. A
  // stray or mistyped DATABASE_URL on a pglite install should be reported, not
  // silently ignored.
  if (db && !db.startsWith('postgresql://') && !db.startsWith('postgres://')) {
    throw new Error(
      `DATABASE_URL must start with postgresql:// or postgres:// (got: ${db.slice(0, 20)}...)`
    );
  }

  const publicOrigin = source.WELTBON_PUBLIC_ORIGIN;
  if (publicOrigin !== undefined && !publicOrigin.startsWith('http://') && !publicOrigin.startsWith('https://')) {
    throw new Error(
      `WELTBON_PUBLIC_ORIGIN must start with http:// or https:// (got: ${publicOrigin.slice(0, 30)}...)`
    );
  }

  const inviteCode = source.INVITE_CODE;
  if (inviteCode !== undefined && inviteCode.length < 16) {
    throw new Error(
      `INVITE_CODE must be at least 16 characters when set (got ${inviteCode.length}). ` +
      `Use \`pnpm --filter api invite:new\` to generate a properly-formed bootstrap code, ` +
      `or unset INVITE_CODE to disable boot-time seeding.`
    );
  }

  // LLMKEY-08: validate format when present, but do NOT require at load time.
  // The conditional "required when llm_api_keys rows exist" check lives at boot
  // (api/src/index.ts assertLlmKeyEncryptionKey) where the DB state is known.
  const llmKeyEncryptionKey = source.LLM_KEY_ENCRYPTION_KEY;
  if (llmKeyEncryptionKey !== undefined && !/^[0-9a-f]{64}$/i.test(llmKeyEncryptionKey)) {
    throw new Error(
      `LLM_KEY_ENCRYPTION_KEY must be a 64-character hex string (32 bytes). ` +
      `Generate one with: openssl rand -hex 32`
    );
  }

  // Phase 24 AUDIT hard caps (T-24-01-03: validate at boot; defaults supplied for safe fallback).
  // Mirror the `port: Number(source.PORT ?? 3000)` pattern: Number() coercion + NaN/non-positive guard.
  const auditMaxToolCalls = Number(source.AUDIT_MAX_TOOL_CALLS ?? 20);
  if (Number.isNaN(auditMaxToolCalls) || auditMaxToolCalls <= 0) {
    throw new Error('AUDIT_MAX_TOOL_CALLS must be a positive number');
  }
  const auditMaxWallClockMs = Number(source.AUDIT_MAX_WALL_CLOCK_MS ?? 120_000);
  if (Number.isNaN(auditMaxWallClockMs) || auditMaxWallClockMs <= 0) {
    throw new Error('AUDIT_MAX_WALL_CLOCK_MS must be a positive number');
  }
  const auditMaxCostUsd = Number(source.AUDIT_MAX_COST_USD ?? 1.00);
  if (Number.isNaN(auditMaxCostUsd) || auditMaxCostUsd <= 0) {
    throw new Error('AUDIT_MAX_COST_USD must be a positive number');
  }
  const auditMaxTokensTotal = Number(source.AUDIT_MAX_TOKENS_TOTAL ?? 200_000);
  if (Number.isNaN(auditMaxTokensTotal) || auditMaxTokensTotal <= 0) {
    throw new Error('AUDIT_MAX_TOKENS_TOTAL must be a positive number');
  }
  const auditShutdownGraceMs = Number(source.AUDIT_SHUTDOWN_GRACE_MS ?? 15_000);
  if (Number.isNaN(auditShutdownGraceMs) || auditShutdownGraceMs <= 0) {
    throw new Error('AUDIT_SHUTDOWN_GRACE_MS must be a positive number');
  }

  return {
    jwtSecret: new TextEncoder().encode(jwt),
    dbDriver,
    databaseUrl: db,
    dataDir,
    chromiumPath: source.CHROMIUM_PATH,
    publicOrigin,
    port: Number(source.PORT ?? 3000),
    webDist: source.WELTBON_WEB_DIST ?? './web-dist',
    llmKeyEncryptionKey,
    auditMaxToolCalls,
    auditMaxWallClockMs,
    auditMaxCostUsd,
    auditMaxTokensTotal,
    auditShutdownGraceMs,
    localMode: source.WELTBON_LOCAL_MODE === '1' || source.WELTBON_LOCAL_MODE === 'true',
    bindHost: source.WELTBON_BIND_HOST,
  };
}

// Lazy: only loaded when first imported by the server entrypoint.
// Tests can call loadEnv(customEnv) directly.
let _env: Env | null = null;
export function env(): Env {
  if (_env === null) _env = loadEnv();
  return _env;
}

/**
 * Tests only: drop the cached Env so a changed process.env is re-read.
 * Leading underscore is this repo's convention for a test-only export — see
 * `_resetModelCacheForTests` in `providers/llm/model-catalog.ts`.
 */
export function _resetEnvForTests(): void { _env = null; }
