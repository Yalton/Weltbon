import { describe, it, expect } from 'vitest';
import { loadEnv } from '../src/config.js';

describe('startup config guard (OPS-04 / AUTH-05a / AUTH-05b)', () => {
  it('throws when JWT_SECRET is missing', () => {
    expect(() =>
      loadEnv({ DATABASE_URL: 'postgresql://localhost/x' } as NodeJS.ProcessEnv)
    ).toThrow(/JWT_SECRET must be set/);
  });

  it('throws when JWT_SECRET has short secret (< 32 chars)', () => {
    expect(() =>
      loadEnv({
        JWT_SECRET: 'too-short',
        DATABASE_URL: 'postgresql://localhost/x',
      } as NodeJS.ProcessEnv)
    ).toThrow(/at least 32 characters/);
  });

  it('throws when DATABASE_URL is missing', () => {
    expect(() =>
      loadEnv({
        JWT_SECRET: 'a'.repeat(32),
      } as NodeJS.ProcessEnv)
    ).toThrow(/DATABASE_URL must be set/);
  });

  it('throws when DATABASE_URL is not a postgres URL', () => {
    expect(() =>
      loadEnv({
        JWT_SECRET: 'a'.repeat(32),
        DATABASE_URL: 'mysql://localhost/x',
      } as NodeJS.ProcessEnv)
    ).toThrow(/postgresql:\/\/ or postgres:\/\//);
  });

  it('returns env object when all vars are valid', () => {
    const env = loadEnv({
      JWT_SECRET: 'a'.repeat(32),
      DATABASE_URL: 'postgresql://localhost/x',
      PORT: '4000',
    } as NodeJS.ProcessEnv);
    expect(env.jwtSecret).toBeInstanceOf(Uint8Array);
    expect(env.jwtSecret.byteLength).toBe(32);
    expect(env.databaseUrl).toBe('postgresql://localhost/x');
    expect(env.port).toBe(4000);
    expect(env.chromiumPath).toBeUndefined();
  });

  it('accepts postgres:// URL scheme', () => {
    const env = loadEnv({
      JWT_SECRET: 'b'.repeat(40),
      DATABASE_URL: 'postgres://localhost/x',
    } as NodeJS.ProcessEnv);
    expect(env.databaseUrl).toBe('postgres://localhost/x');
  });

  it('returns env.publicOrigin === undefined when WELTBON_PUBLIC_ORIGIN is absent (PROXY-01)', () => {
    const env = loadEnv({
      JWT_SECRET: 'a'.repeat(32),
      DATABASE_URL: 'postgresql://localhost/x',
    } as NodeJS.ProcessEnv);
    expect(env.publicOrigin).toBeUndefined();
  });

  it('returns env.publicOrigin set to the configured value when WELTBON_PUBLIC_ORIGIN is a valid https URL (PROXY-01)', () => {
    const env = loadEnv({
      JWT_SECRET: 'a'.repeat(32),
      DATABASE_URL: 'postgresql://localhost/x',
      WELTBON_PUBLIC_ORIGIN: 'https://welt.example.com',
    } as NodeJS.ProcessEnv);
    expect(env.publicOrigin).toBe('https://welt.example.com');
  });

  it('throws when WELTBON_PUBLIC_ORIGIN is set but is malformed (no http(s):// prefix) (PROXY-01)', () => {
    expect(() =>
      loadEnv({
        JWT_SECRET: 'a'.repeat(32),
        DATABASE_URL: 'postgresql://localhost/x',
        WELTBON_PUBLIC_ORIGIN: 'welt.example.com',
      } as NodeJS.ProcessEnv)
    ).toThrow(/WELTBON_PUBLIC_ORIGIN must start with http:\/\/ or https:\/\//);
  });

  it('throws when INVITE_CODE is set but shorter than 16 characters', () => {
    expect(() =>
      loadEnv({
        JWT_SECRET: 'a'.repeat(32),
        DATABASE_URL: 'postgresql://localhost/x',
        INVITE_CODE: 'hunter2',
      } as NodeJS.ProcessEnv)
    ).toThrow(/INVITE_CODE must be at least 16 characters/);
  });

  it('accepts INVITE_CODE of exactly 16 characters', () => {
    expect(() =>
      loadEnv({
        JWT_SECRET: 'a'.repeat(32),
        DATABASE_URL: 'postgresql://localhost/x',
        INVITE_CODE: 'abcdef1234567890', // 16 chars
      } as NodeJS.ProcessEnv)
    ).not.toThrow();
  });

  it('accepts INVITE_CODE unset (no validation triggered)', () => {
    expect(() =>
      loadEnv({
        JWT_SECRET: 'a'.repeat(32),
        DATABASE_URL: 'postgresql://localhost/x',
      } as NodeJS.ProcessEnv)
    ).not.toThrow();
  });


  const validEnv = {
    JWT_SECRET: 'a'.repeat(32),
    DATABASE_URL: 'postgresql://localhost/x',
  } as NodeJS.ProcessEnv;

  it('throws when AUDIT_MAX_TOOL_CALLS is NaN (T-24-01-03)', () => {
    expect(() =>
      loadEnv({ ...validEnv, AUDIT_MAX_TOOL_CALLS: 'NaN' } as NodeJS.ProcessEnv)
    ).toThrow(/AUDIT_MAX_TOOL_CALLS must be a positive number/);
  });

  it('throws when AUDIT_MAX_WALL_CLOCK_MS is NaN (T-24-01-03)', () => {
    expect(() =>
      loadEnv({ ...validEnv, AUDIT_MAX_WALL_CLOCK_MS: 'NaN' } as NodeJS.ProcessEnv)
    ).toThrow(/AUDIT_MAX_WALL_CLOCK_MS must be a positive number/);
  });

  it('throws when AUDIT_MAX_COST_USD is NaN (T-24-01-03)', () => {
    expect(() =>
      loadEnv({ ...validEnv, AUDIT_MAX_COST_USD: 'NaN' } as NodeJS.ProcessEnv)
    ).toThrow(/AUDIT_MAX_COST_USD must be a positive number/);
  });

  it('throws when AUDIT_MAX_TOKENS_TOTAL is NaN (T-24-01-03)', () => {
    expect(() =>
      loadEnv({ ...validEnv, AUDIT_MAX_TOKENS_TOTAL: 'NaN' } as NodeJS.ProcessEnv)
    ).toThrow(/AUDIT_MAX_TOKENS_TOTAL must be a positive number/);
  });

  it('throws when AUDIT_SHUTDOWN_GRACE_MS is NaN (T-24-01-03)', () => {
    expect(() =>
      loadEnv({ ...validEnv, AUDIT_SHUTDOWN_GRACE_MS: 'NaN' } as NodeJS.ProcessEnv)
    ).toThrow(/AUDIT_SHUTDOWN_GRACE_MS must be a positive number/);
  });

  it('returns documented AUDIT_* defaults when env vars are unset (T-24-01-03)', () => {
    const result = loadEnv(validEnv);
    expect(result.auditMaxToolCalls).toBe(20);
    expect(result.auditMaxWallClockMs).toBe(120_000);
    expect(result.auditMaxCostUsd).toBe(1.00);
    expect(result.auditMaxTokensTotal).toBe(200_000);
    expect(result.auditShutdownGraceMs).toBe(15_000);
  });

  // ── DV-03: driver selection ────────────────────────────────────────────────

  it('defaults to the postgres driver when WELTBON_DB_DRIVER is unset', () => {
    const env = loadEnv({
      JWT_SECRET: 'a'.repeat(32),
      DATABASE_URL: 'postgresql://localhost/x',
    } as NodeJS.ProcessEnv);
    expect(env.dbDriver).toBe('postgres');
    expect(env.dataDir).toBeUndefined();
  });

  it('rejects an unknown WELTBON_DB_DRIVER', () => {
    expect(() =>
      loadEnv({
        JWT_SECRET: 'a'.repeat(32),
        DATABASE_URL: 'postgresql://localhost/x',
        WELTBON_DB_DRIVER: 'sqlite',
      } as NodeJS.ProcessEnv)
    ).toThrow(/WELTBON_DB_DRIVER must be "postgres" or "pglite"/);
  });

  it('requires WELTBON_DATA_DIR when the driver is pglite', () => {
    expect(() =>
      loadEnv({
        JWT_SECRET: 'a'.repeat(32),
        WELTBON_DB_DRIVER: 'pglite',
      } as NodeJS.ProcessEnv)
    ).toThrow(/WELTBON_DATA_DIR must be set/);
  });

  it('does NOT require DATABASE_URL when the driver is pglite', () => {
    const env = loadEnv({
      JWT_SECRET: 'a'.repeat(32),
      WELTBON_DB_DRIVER: 'pglite',
      WELTBON_DATA_DIR: '/tmp/weltbon-data',
    } as NodeJS.ProcessEnv);
    expect(env.dbDriver).toBe('pglite');
    expect(env.dataDir).toBe('/tmp/weltbon-data');
    expect(env.databaseUrl).toBeUndefined();
  });

  it('still rejects a malformed DATABASE_URL under the pglite driver when one IS given', () => {
    // The scheme check must not become dead code just because the driver
    // changed: a stray DATABASE_URL should still be caught, not silently
    // ignored, or a mis-set var goes unnoticed on a desktop install.
    expect(() =>
      loadEnv({
        JWT_SECRET: 'a'.repeat(32),
        WELTBON_DB_DRIVER: 'pglite',
        WELTBON_DATA_DIR: '/tmp/weltbon-data',
        DATABASE_URL: 'mysql://localhost/x',
      } as NodeJS.ProcessEnv)
    ).toThrow(/postgresql:\/\/ or postgres:\/\//);
  });
});
