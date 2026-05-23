/**
 * Phase 22 BYOK — LLM API key encryption + decryption.
 *
 * Two exports consumed by Plan 22-04 (routes) and Phase 23+ (provider abstraction):
 *
 *   - encryptKey(plaintext, encryptionKeyHex):
 *       AES-256-GCM with per-call random 12-byte IV + 16-byte auth tag.
 *       Pure function. Returns hex-encoded { ciphertext, iv, authTag, bodySuffix, version: 1 }.
 *
 *   - getDecryptedKey(userId, provider, encryptionKeyHex):
 *       Per-call DB read + decrypt. Returns string | null where null covers FOUR cases
 *       (D-11): no row, decryption failure, missing LLM_KEY_ENCRYPTION_KEY env var, or
 *       malformed (non-64-hex) env var. Caller cannot distinguish — treat null as
 *       "no usable key". No cache anywhere (D-10).
 *
 * Phase 23 D-03 (D-03b) — provider-ping helpers moved out:
 *   The Phase 22 provider-validation function and its typed-error class that
 *   previously lived here have been removed. They are now provided by the
 *   provider abstraction in `api/src/providers/llm/` via
 *   `getProvider(provider).validate(plaintext)` which throws `LLMProviderError`
 *   (variant: `LLMError.InvalidApiKey` for rejected keys, `LLMError.NetworkError`
 *   for transient/timeout, etc.). This module retains only the AES-256-GCM key
 *   crypto + the `LlmProvider` / `EncryptedKey` types.
 *
 * Trust boundary discipline (T-22-02-01, T-22-02-02, T-22-02-06):
 *   - No console.log / console.info / console.error in this module.
 *   - The single permitted console.warn line is metadata-only — never references
 *     plaintext, ciphertext, iv, authTag, encryptionKeyHex, keyBuf, or err.message.
 */

import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { eq, and } from 'drizzle-orm';
import { db as getDb } from '../db/client.js';
import { llmApiKeys } from '../db/schema.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface EncryptedKey {
  ciphertext: string;   // hex of AES-256-GCM ciphertext
  iv: string;           // 24 hex chars (12 random bytes — never reused)
  authTag: string;      // 32 hex chars (16-byte GCM auth tag)
  bodySuffix: string;   // last 4 chars of plaintext (D-14)
  version: 1;           // D-12 — always 1 in v3.0
}

export type LlmProvider = 'anthropic' | 'openai';

// ---------------------------------------------------------------------------
// encryptKey
// ---------------------------------------------------------------------------

/**
 * AES-256-GCM encrypt. Per-call random 12-byte IV — never reused.
 *
 * Caller is responsible for validating `encryptionKeyHex` (config.ts checks
 * the 64-hex-char shape at boot). If the hex is malformed, Buffer.from will
 * silently produce a short buffer and createCipheriv will throw — but the
 * boundary that swallows that throw is `getDecryptedKey`, not encryptKey.
 * In encryption (POST route) flow, a malformed key MUST be caught at config
 * boot via the LLMKEY-08 fail-fast.
 */
export function encryptKey(plaintext: string, encryptionKeyHex: string): EncryptedKey {
  const keyBuf = Buffer.from(encryptionKeyHex, 'hex');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', keyBuf, iv);
  const ciphertextBuf = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return {
    ciphertext: ciphertextBuf.toString('hex'),
    iv: iv.toString('hex'),
    authTag: authTag.toString('hex'),
    bodySuffix: plaintext.slice(-4),
    version: 1,
  };
}

// ---------------------------------------------------------------------------
// getDecryptedKey
// ---------------------------------------------------------------------------

const HEX_KEY_RE = /^[0-9a-f]{64}$/i;

/**
 * Per-call DB read + AES-256-GCM decrypt. Returns null on any failure.
 *
 * Failure cases collapsed into null (D-11):
 *   (a) encryptionKeyHex param is undefined / empty
 *   (b) encryptionKeyHex param is malformed (not 64 hex chars)
 *   (c) No row exists for the (userId, provider) pair
 *   (d) Decryption throws (auth tag mismatch — tampered ciphertext/authTag, wrong key, etc.)
 *   (e) Row's encryptedKeyVersion is not 1 (CR-02 — see version guard below)
 *
 * CR-01 fix: The encryption key is passed in by the caller from `cfg.llmKeyEncryptionKey`
 * — same source of truth as the boot fail-fast (`assertLlmKeyEncryptionKey`) and the
 * POST/PUT 503 gates. Previously this function re-read `process.env.LLM_KEY_ENCRYPTION_KEY`,
 * which created a drift hazard: a post-boot env mutation (test fixture or operator) would
 * leave the boot guard satisfied while silently null-ing every decrypt. With the param,
 * there is exactly one source of truth (`cfg`) and the LLMKEY-08 boot guard is load-bearing.
 *
 * D-10: every call performs a fresh DB read; no cache, no per-request memo.
 */
export const getDecryptedKey = async (
  userId: string,
  provider: LlmProvider,
  encryptionKeyHex: string | undefined,
): Promise<string | null> => {
  if (encryptionKeyHex === undefined || !HEX_KEY_RE.test(encryptionKeyHex)) {
    return null;
  }

  try {
    const rows = await getDb()
      .select()
      .from(llmApiKeys)
      .where(and(eq(llmApiKeys.userId, userId), eq(llmApiKeys.provider, provider)))
      .limit(1);

    if (rows.length === 0) return null;
    const row = rows[0];

    // CR-02 fix: pin the version explicitly. encryptedKeyVersion is persisted
    // on every INSERT/UPDATE; without this guard a future v2 row would be
    // decrypted with the current key and produce an auth-tag failure → silent
    // null with no diagnostic surface to distinguish "wrong key" from "wrong
    // version" from "tampering". Operators need to know rotation tooling has
    // not landed yet. The warn line is metadata-only (no plaintext/ciphertext/
    // key material — T-22-02-01..06).
    if (row.encryptedKeyVersion !== 1) {
      console.warn(
        '[llm-key] unsupported encryptedKeyVersion for user',
        userId,
        'provider',
        provider,
        'version',
        row.encryptedKeyVersion,
      );
      return null;
    }

    const keyBuf = Buffer.from(encryptionKeyHex, 'hex');
    const ivBuf = Buffer.from(row.iv, 'hex');
    const authTagBuf = Buffer.from(row.authTag, 'hex');
    const ciphertextBuf = Buffer.from(row.ciphertext, 'hex');

    const decipher = createDecipheriv('aes-256-gcm', keyBuf, ivBuf);
    // CRITICAL: setAuthTag MUST be called BEFORE the first update() call.
    // Out-of-order produces silently-wrong output on success and "Unsupported state"
    // on failure (the same silent-on-failure footgun the round-trip test pins).
    decipher.setAuthTag(authTagBuf);
    const decrypted =
      decipher.update(ciphertextBuf, undefined, 'utf8') + decipher.final('utf8');
    return decrypted;
  } catch {
    // Metadata-only warn. NEVER reference err.message, plaintext, ciphertext, iv,
    // authTag, keyBuf, encryptionKeyHex. The userId + provider tuple is the only
    // diagnostic surface we expose (operator can correlate to the DB row).
    console.warn('[llm-key] decryption failed for user', userId, 'provider', provider);
    return null;
  }
};
