// api/src/config.ts
export interface Env {
  jwtSecret: Uint8Array;
  databaseUrl: string;
  chromiumPath: string | undefined;
  publicOrigin: string | undefined;
  port: number;
}

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const jwt = source.JWT_SECRET;
  const db = source.DATABASE_URL;

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
  if (!db) {
    throw new Error('DATABASE_URL must be set (expected postgresql:// URL).');
  }
  if (!db.startsWith('postgresql://') && !db.startsWith('postgres://')) {
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

  return {
    jwtSecret: new TextEncoder().encode(jwt),
    databaseUrl: db,
    chromiumPath: source.CHROMIUM_PATH,
    publicOrigin,
    port: Number(source.PORT ?? 3000),
  };
}

// Lazy: only loaded when first imported by the server entrypoint.
// Tests can call loadEnv(customEnv) directly.
let _env: Env | null = null;
export function env(): Env {
  if (_env === null) _env = loadEnv();
  return _env;
}
