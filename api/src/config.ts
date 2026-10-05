export type DbDriver = 'postgres' | 'pglite';

export interface Env {
  jwtSecret: Uint8Array;
  dbDriver: DbDriver;
  databaseUrl: string | undefined;
  dataDir: string | undefined;
  chromiumPath: string | undefined;
  publicOrigin: string | undefined;
  port: number;
  webDist: string;
  llmKeyEncryptionKey: string | undefined;
  auditMaxToolCalls: number;     // AUDIT_MAX_TOOL_CALLS, default 20
  auditMaxWallClockMs: number;   // AUDIT_MAX_WALL_CLOCK_MS, default 120_000
  auditMaxCostUsd: number;       // AUDIT_MAX_COST_USD, default 1.00
  auditMaxTokensTotal: number;   // AUDIT_MAX_TOKENS_TOTAL, default 200_000
  auditShutdownGraceMs: number;  // AUDIT_SHUTDOWN_GRACE_MS, default 15_000
  sharedLlmMonthlyCostUsd: number;
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
  autoSyncEnabled: boolean;
  /** INVITE_REQUESTS_ENABLED, default true: landing page offers the invite-request form. */
  inviteRequestsEnabled: boolean;
  /** LANDING_REPO_URL: where the landing page sends visitors who want to self-host. */
  landingRepoUrl: string;
  /**
   * WELTBON_TRUST_PROXY, default false: whether X-Forwarded-For names the client.
   * Only true behind a reverse proxy that overwrites the header (docs/reverse-proxy).
   */
  trustProxy: boolean;
}

const DEFAULT_LANDING_REPO_URL = 'https://github.com/Citreum-LLC/Weltbon';

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
  const llmKeyEncryptionKey = source.LLM_KEY_ENCRYPTION_KEY;
  if (llmKeyEncryptionKey !== undefined && !/^[0-9a-f]{64}$/i.test(llmKeyEncryptionKey)) {
    throw new Error(
      `LLM_KEY_ENCRYPTION_KEY must be a 64-character hex string (32 bytes). ` +
      `Generate one with: openssl rand -hex 32`
    );
  }

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
  const sharedLlmMonthlyCostUsd = Number(source.SHARED_LLM_MONTHLY_COST_USD ?? 1.00);
  if (!Number.isFinite(sharedLlmMonthlyCostUsd) || sharedLlmMonthlyCostUsd <= 0) {
    throw new Error('SHARED_LLM_MONTHLY_COST_USD must be a finite positive number');
  }

  const rawInviteRequests = source.INVITE_REQUESTS_ENABLED ?? 'true';
  if (rawInviteRequests !== 'true' && rawInviteRequests !== 'false') {
    throw new Error(
      `INVITE_REQUESTS_ENABLED must be "true" or "false" (got "${rawInviteRequests}").`
    );
  }

  const rawTrustProxy = source.WELTBON_TRUST_PROXY ?? 'false';
  if (rawTrustProxy !== 'true' && rawTrustProxy !== 'false') {
    throw new Error(
      `WELTBON_TRUST_PROXY must be "true" or "false" (got "${rawTrustProxy}").`
    );
  }

  // Rendered as an href on a public page, so anything but http(s) is refused.
  const landingRepoUrl = source.LANDING_REPO_URL ?? DEFAULT_LANDING_REPO_URL;
  let repoProtocol: string | undefined;
  try { repoProtocol = new URL(landingRepoUrl).protocol; } catch { /* reported below */ }
  if (repoProtocol !== 'http:' && repoProtocol !== 'https:') {
    throw new Error(
      `LANDING_REPO_URL must be an http:// or https:// URL (got: ${landingRepoUrl.slice(0, 30)}...)`
    );
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
    sharedLlmMonthlyCostUsd,
    localMode: source.WELTBON_LOCAL_MODE === '1' || source.WELTBON_LOCAL_MODE === 'true',
    // `|| undefined` (not `??`): an explicitly-set-but-empty WELTBON_BIND_HOST=
    // must fall back to the all-interfaces default too, not pass '' through to
    bindHost: source.WELTBON_BIND_HOST || undefined,
    // leaves auto-sync running.
    autoSyncEnabled: source.WELTBON_AUTO_SYNC !== 'off',
    inviteRequestsEnabled: rawInviteRequests === 'true',
    landingRepoUrl,
    trustProxy: rawTrustProxy === 'true',
  };
}

let _env: Env | null = null;
export function env(): Env {
  if (_env === null) _env = loadEnv();
  return _env;
}

export function _resetEnvForTests(): void { _env = null; }
