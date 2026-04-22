// api/src/config.ts
export interface Env {
  jwtSecret: Uint8Array;
  databaseUrl: string;
  chromiumPath: string | undefined;
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

  return {
    jwtSecret: new TextEncoder().encode(jwt),
    databaseUrl: db,
    chromiumPath: source.CHROMIUM_PATH,
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
