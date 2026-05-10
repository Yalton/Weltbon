import { describe, it, expect } from 'vitest';
import { generateInviteToken, hashInviteToken, INVITE_PREFIX } from '../src/services/invite.js';

describe('invite service', () => {
  it('exports INVITE_PREFIX as "wbn_inv_"', () => {
    expect(INVITE_PREFIX).toBe('wbn_inv_');
  });

  it('generateInviteToken().plaintext starts with the prefix and is 51 chars total', () => {
    const { plaintext } = generateInviteToken();
    expect(plaintext.startsWith('wbn_inv_')).toBe(true);
    expect(plaintext).toHaveLength(51);
  });

  it('generateInviteToken().hash is 64 lowercase hex chars (SHA-256)', () => {
    const { hash } = generateInviteToken();
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('generateInviteToken().bodySuffix is the last 3 chars of the post-prefix body', () => {
    const { plaintext, bodySuffix } = generateInviteToken();
    const body = plaintext.slice(INVITE_PREFIX.length);
    expect(bodySuffix).toHaveLength(3);
    expect(bodySuffix).toBe(body.slice(-3));
  });

  it('two consecutive calls produce distinct plaintext and hash (entropy)', () => {
    const a = generateInviteToken();
    const b = generateInviteToken();
    expect(a.plaintext).not.toBe(b.plaintext);
    expect(a.hash).not.toBe(b.hash);
  });

  it('hashInviteToken is deterministic for a given input', () => {
    const sample = 'wbn_inv_deterministic-input-fixture';
    expect(hashInviteToken(sample)).toBe(hashInviteToken(sample));
  });

  it('hashInviteToken agrees with the generator hash field', () => {
    const { plaintext, hash } = generateInviteToken();
    expect(hashInviteToken(plaintext)).toBe(hash);
  });
});
