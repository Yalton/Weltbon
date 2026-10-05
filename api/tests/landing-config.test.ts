import { describe, expect, it } from 'vitest';
import { loadEnv } from '../src/config.js';

const base = {
  JWT_SECRET: 'test-jwt-secret-which-is-long-enough',
  DATABASE_URL: 'postgresql://localhost/weltbon',
};

describe('landing page configuration', () => {
  it('enables invite requests and points at the public repo by default', () => {
    const loaded = loadEnv(base);
    expect(loaded.inviteRequestsEnabled).toBe(true);
    expect(loaded.landingRepoUrl).toBe('https://github.com/Citreum-LLC/Weltbon');
  });

  it.each([
    ['true', true],
    ['false', false],
  ] as const)('reads INVITE_REQUESTS_ENABLED=%s', (value, expected) => {
    expect(loadEnv({ ...base, INVITE_REQUESTS_ENABLED: value }).inviteRequestsEnabled).toBe(expected);
  });

  it.each(['1', 'yes', 'TRUE', ''])('rejects INVITE_REQUESTS_ENABLED=%j', (value) => {
    expect(() => loadEnv({ ...base, INVITE_REQUESTS_ENABLED: value })).toThrow('INVITE_REQUESTS_ENABLED');
  });

  it('accepts an http(s) LANDING_REPO_URL override', () => {
    const loaded = loadEnv({ ...base, LANDING_REPO_URL: 'https://git.example.com/me/weltbon' });
    expect(loaded.landingRepoUrl).toBe('https://git.example.com/me/weltbon');
  });

  it.each(['not a url', 'javascript:alert(1)', 'ftp://example.com/repo'])(
    'rejects LANDING_REPO_URL=%j',
    (value) => {
      expect(() => loadEnv({ ...base, LANDING_REPO_URL: value })).toThrow('LANDING_REPO_URL');
    },
  );
});
