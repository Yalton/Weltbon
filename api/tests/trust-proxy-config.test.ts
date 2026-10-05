import { describe, expect, it } from 'vitest';
import { loadEnv } from '../src/config.js';

const base = {
  JWT_SECRET: 'test-jwt-secret-which-is-long-enough',
  DATABASE_URL: 'postgresql://localhost/weltbon',
};

describe('WELTBON_TRUST_PROXY', () => {
  it('is off by default, so a directly exposed server ignores X-Forwarded-For', () => {
    expect(loadEnv(base).trustProxy).toBe(false);
  });

  it.each([
    ['true', true],
    ['false', false],
  ] as const)('reads %s', (value, expected) => {
    expect(loadEnv({ ...base, WELTBON_TRUST_PROXY: value }).trustProxy).toBe(expected);
  });

  it.each(['1', 'yes', ''])('rejects %j', (value) => {
    expect(() => loadEnv({ ...base, WELTBON_TRUST_PROXY: value })).toThrow('WELTBON_TRUST_PROXY');
  });
});
