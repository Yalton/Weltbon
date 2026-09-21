import { describe, it, expect } from 'vitest';
import { randomBytes } from 'node:crypto';
import { encryptSecret, decryptSecret, type EncryptedSecret } from '../src/services/crypto.js';

const KEY = randomBytes(32).toString('hex');

describe('crypto: AES-256-GCM secret envelope', () => {
  it('round-trips a secret', () => {
    const enc = encryptSecret('wbn_pat_super-secret-token-body', KEY);
    expect(enc.version).toBe(1);
    expect(enc.bodySuffix).toBe('body');
    expect(decryptSecret(enc, KEY)).toBe('wbn_pat_super-secret-token-body');
  });

  it('unique IV per call — same plaintext, different ciphertext', () => {
    const a = encryptSecret('same', KEY);
    const b = encryptSecret('same', KEY);
    expect(a.iv).not.toBe(b.iv);
    expect(a.ciphertext).not.toBe(b.ciphertext);
  });

  it('returns null on tamper (auth tag) and on wrong key', () => {
    const enc = encryptSecret('secret', KEY);
    const tampered: EncryptedSecret = { ...enc, ciphertext: enc.ciphertext.replace(/^../, 'ff') };
    expect(decryptSecret(tampered, KEY)).toBeNull();
    expect(decryptSecret(enc, randomBytes(32).toString('hex'))).toBeNull();
  });

  it('returns null on malformed key or unknown version', () => {
    const enc = encryptSecret('secret', KEY);
    expect(decryptSecret(enc, 'not-hex')).toBeNull();
    expect(decryptSecret({ ...enc, version: 2 as 1 }, KEY)).toBeNull();
  });
});
