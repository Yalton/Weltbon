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
});
