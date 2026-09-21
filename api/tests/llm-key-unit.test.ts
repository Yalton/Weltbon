
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { randomBytes } from 'node:crypto';

// Mock the drizzle client BEFORE importing the SUT.
vi.mock('../src/db/client.js', () => ({
  db: vi.fn(),
}));

import { db as getDb } from '../src/db/client.js';
import {
  encryptKey,
  getDecryptedKey,
  type EncryptedKey,
  type LlmProvider,
} from '../src/services/llm-key.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

// Generated once per file run — every test against a single, valid 64-hex key.
const TEST_KEY_HEX = randomBytes(32).toString('hex');

interface FakeRow {
  id: string;
  userId: string;
  provider: string;
  ciphertext: string;
  iv: string;
  authTag: string;
  encryptedKeyVersion: number;
  bodySuffix: string;
  label: string;
  createdAt: Date;
  lastValidatedAt: Date | null;
}

/**
 * Wire the mocked `db()` function to a chainable that resolves
 * `.select().from(...).where(...).limit(1)` to the given rows.
 */
function mockDbReturning(rows: FakeRow[]): void {
  vi.mocked(getDb).mockReturnValue({
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve(rows),
        }),
      }),
    }),
  } as never);
}

/**
 * Build a fully-formed fake row from an encryptKey result, ready to feed
 * to mockDbReturning().
 */
function rowFromEncryption(
  userId: string,
  provider: LlmProvider,
  enc: EncryptedKey,
): FakeRow {
  return {
    id: 'row-' + Math.random().toString(36).slice(2),
    userId,
    provider,
    ciphertext: enc.ciphertext,
    iv: enc.iv,
    authTag: enc.authTag,
    encryptedKeyVersion: enc.version,
    bodySuffix: enc.bodySuffix,
    label: '',
    createdAt: new Date(),
    lastValidatedAt: new Date(),
  };
}

beforeEach(() => {
  process.env.LLM_KEY_ENCRYPTION_KEY = TEST_KEY_HEX;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// encryptKey: shape + determinism
// ---------------------------------------------------------------------------

describe('llm-key service: encryptKey', () => {
  it('returns ciphertext, iv (24 hex), authTag (32 hex), bodySuffix (4 chars), version 1', () => {
    const enc = encryptKey('sk-ant-PLAINTEXT-12345678', TEST_KEY_HEX);
    expect(enc.ciphertext).toMatch(/^[0-9a-f]+$/i);
    expect(enc.iv).toMatch(/^[0-9a-f]{24}$/i);
    expect(enc.authTag).toMatch(/^[0-9a-f]{32}$/i);
    expect(enc.bodySuffix).toHaveLength(4);
    expect(enc.version).toBe(1);
  });

  it('produces a different iv on two consecutive calls with the same plaintext + key', () => {
    const a = encryptKey('sk-ant-SAME-INPUT-XYZ', TEST_KEY_HEX);
    const b = encryptKey('sk-ant-SAME-INPUT-XYZ', TEST_KEY_HEX);
    expect(a.iv).not.toBe(b.iv);
  });

  it('produces a different ciphertext on two consecutive calls with the same plaintext + key', () => {
    const a = encryptKey('sk-ant-SAME-INPUT-XYZ', TEST_KEY_HEX);
    const b = encryptKey('sk-ant-SAME-INPUT-XYZ', TEST_KEY_HEX);
    expect(a.ciphertext).not.toBe(b.ciphertext);
  });

  it('uses the LAST 4 chars of plaintext as bodySuffix', () => {
    const enc = encryptKey('sk-ant-ZZZZZZZZ-WXYZ', TEST_KEY_HEX);
    expect(enc.bodySuffix).toBe('WXYZ');
  });
});

// ---------------------------------------------------------------------------
// getDecryptedKey: round-trip + null branches
// ---------------------------------------------------------------------------

describe('llm-key service: getDecryptedKey', () => {
  it('round-trips a saved row through encryptKey + getDecryptedKey to the original plaintext', async () => {
    const plaintext = 'sk-ant-roundtrip-PLAINTEXT-9999';
    const enc = encryptKey(plaintext, TEST_KEY_HEX);
    mockDbReturning([rowFromEncryption('user-1', 'anthropic', enc)]);

    const got = await getDecryptedKey('user-1', 'anthropic', process.env.LLM_KEY_ENCRYPTION_KEY);
    expect(got).toBe(plaintext);
  });

  it('returns null when the DB returns no rows for the (userId, provider) pair', async () => {
    mockDbReturning([]);
    const got = await getDecryptedKey('user-1', 'anthropic', process.env.LLM_KEY_ENCRYPTION_KEY);
    expect(got).toBeNull();
  });

  it('returns null when authTag is tampered (one hex char flipped) — does not throw', async () => {
    const plaintext = 'sk-ant-TAMPER-AUTHTAG-12345';
    const enc = encryptKey(plaintext, TEST_KEY_HEX);
    // Flip the last hex char of authTag.
    const lastChar = enc.authTag.slice(-1);
    const flipped = lastChar === 'f' ? '0' : 'f';
    const tamperedAuthTag = enc.authTag.slice(0, -1) + flipped;
    mockDbReturning([
      rowFromEncryption('user-1', 'anthropic', { ...enc, authTag: tamperedAuthTag }),
    ]);

    let threw = false;
    let got: string | null = 'sentinel';
    try {
      got = await getDecryptedKey('user-1', 'anthropic', TEST_KEY_HEX);
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);
    expect(got).toBeNull();
  });

  it('returns null when ciphertext is tampered — does not throw', async () => {
    const plaintext = 'sk-ant-TAMPER-CIPHERTEXT-9876';
    const enc = encryptKey(plaintext, TEST_KEY_HEX);
    // Flip the first hex char of ciphertext.
    const firstChar = enc.ciphertext.charAt(0);
    const flipped = firstChar === 'f' ? '0' : 'f';
    const tamperedCiphertext = flipped + enc.ciphertext.slice(1);
    mockDbReturning([
      rowFromEncryption('user-1', 'anthropic', { ...enc, ciphertext: tamperedCiphertext }),
    ]);

    let threw = false;
    let got: string | null = 'sentinel';
    try {
      got = await getDecryptedKey('user-1', 'anthropic', TEST_KEY_HEX);
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);
    expect(got).toBeNull();
  });

  it('returns null when encryptionKeyHex param is undefined — does not throw', async () => {
    // No DB stub needed — the param check short-circuits before the DB read.
    let threw = false;
    let got: string | null = 'sentinel';
    try {
      got = await getDecryptedKey('user-1', 'anthropic', undefined);
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);
    expect(got).toBeNull();
  });

  it('returns null when encryptionKeyHex param is malformed (63 hex chars) — does not throw', async () => {
    let threw = false;
    let got: string | null = 'sentinel';
    try {
      got = await getDecryptedKey('user-1', 'anthropic', 'a'.repeat(63));
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);
    expect(got).toBeNull();
  });

  it('returns null when encryptionKeyHex param is malformed (non-hex chars) — does not throw', async () => {
    let threw = false;
    let got: string | null = 'sentinel';
    try {
      got = await getDecryptedKey('user-1', 'anthropic', 'z'.repeat(64));
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);
    expect(got).toBeNull();
  });

  it('returns null when the encryption key does not match (rotation-mismatch) — does not throw', async () => {
    const plaintext = 'sk-ant-WRONG-KEY-AT-DECRYPT-555';
    const encryptHex = randomBytes(32).toString('hex');
    const enc = encryptKey(plaintext, encryptHex);
    mockDbReturning([rowFromEncryption('user-1', 'anthropic', enc)]);
    // Decrypt with a DIFFERENT key than the one used to encrypt.
    expect(TEST_KEY_HEX).not.toBe(encryptHex);

    let threw = false;
    let got: string | null = 'sentinel';
    try {
      got = await getDecryptedKey('user-1', 'anthropic', TEST_KEY_HEX);
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);
    expect(got).toBeNull();
  });

  // CR-01 regression: the function MUST use the passed param, not re-read
  // process.env. If a future refactor re-reads process.env, this test fails:
  // we supply a VALID hex string via param but DELETE the env var. The
  // function must succeed (no env dependency).
  it('uses the encryptionKeyHex param and does NOT re-read process.env (CR-01 regression)', async () => {
    const plaintext = 'sk-ant-PARAM-NOT-ENV-7777';
    const enc = encryptKey(plaintext, TEST_KEY_HEX);
    mockDbReturning([rowFromEncryption('user-1', 'anthropic', enc)]);
    // Sabotage process.env so any accidental re-read would null-out the result.
    delete process.env.LLM_KEY_ENCRYPTION_KEY;
    const got = await getDecryptedKey('user-1', 'anthropic', TEST_KEY_HEX);
    expect(got).toBe(plaintext);
  });

  // CR-02 regression: any encryptedKeyVersion ≠ 1 must short-circuit to null
  // BEFORE the decipher is constructed. This catches a future v2 row that
  // would otherwise reach createDecipheriv and produce a silent auth-tag
  // failure indistinguishable from "wrong key" or "tampered ciphertext".
  it('returns null when row.encryptedKeyVersion is not 1 — does not throw (CR-02)', async () => {
    const plaintext = 'sk-ant-VERSION-MISMATCH-V2-AAAA';
    const enc = encryptKey(plaintext, TEST_KEY_HEX);
    // Fabricate a v2 row — encryption is real (so a missing version guard would
    // succeed at decrypt and return the plaintext). The guard must reject the
    // row purely on the version field.
    const v2Row = { ...rowFromEncryption('user-1', 'anthropic', enc), encryptedKeyVersion: 2 };
    mockDbReturning([v2Row]);
    let threw = false;
    let got: string | null = 'sentinel';
    try {
      got = await getDecryptedKey('user-1', 'anthropic', TEST_KEY_HEX);
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);
    expect(got).toBeNull();
  });

  it('returns null when row.encryptedKeyVersion is 0 — does not throw (CR-02 — defensive lower bound)', async () => {
    const plaintext = 'sk-ant-VERSION-ZERO-BBBB';
    const enc = encryptKey(plaintext, TEST_KEY_HEX);
    const v0Row = { ...rowFromEncryption('user-1', 'anthropic', enc), encryptedKeyVersion: 0 };
    mockDbReturning([v0Row]);
    const got = await getDecryptedKey('user-1', 'anthropic', TEST_KEY_HEX);
    expect(got).toBeNull();
  });
});
