/**
 * Shared AES-256-GCM secret envelope (Plan A).
 *
 * Extracted from llm-key.ts (`encryptKey`, decrypt core inside `getDecryptedKey`)
 * so sync_remotes (encrypted PATs) and llm_api_keys share one audited
 * implementation. Key: 64-char hex (32 bytes) — the LLM_KEY_ENCRYPTION_KEY
 * config value (config.ts) remains the single key source for both consumers.
 *
 * Behavior parity note (fidelity check against llm-key.ts, 2026-07-17):
 *   - encryptSecret does NOT pre-validate the hex key shape, mirroring
 *     encryptKey exactly — llm-key.ts relies on the LLMKEY-08 boot fail-fast
 *     to guarantee a well-formed key ever reaches this function. A malformed
 *     key still fails loudly (Buffer/cipher throws), it just isn't given a
 *     custom message here, to stay byte-for-byte behavior-identical with the
 *     function being extracted.
 *   - decryptSecret's guard (HEX_KEY_RE + version) mirrors the guard at the
 *     top of getDecryptedKey, which returns null before ever touching the DB
 *     or the decipher for a malformed/undefined key.
 */
import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';

const HEX_KEY_RE = /^[0-9a-f]{64}$/i;

export interface EncryptedSecret {
  ciphertext: string; // hex
  iv: string; // hex, 12 bytes
  authTag: string; // hex, 16 bytes
  bodySuffix: string; // last 4 chars of plaintext, for display
  version: 1;
}

/**
 * AES-256-GCM encrypt. Per-call random 12-byte IV — never reused.
 *
 * Caller is responsible for validating `encryptionKeyHex` (config.ts checks
 * the 64-hex-char shape at boot). If the hex is malformed, Buffer.from will
 * silently produce a short buffer and createCipheriv will throw.
 */
export function encryptSecret(plaintext: string, encryptionKeyHex: string): EncryptedSecret {
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

/** Null on ANY failure (malformed key, wrong version, tamper) — never throws. */
export function decryptSecret(enc: EncryptedSecret, encryptionKeyHex: string): string | null {
  if (!HEX_KEY_RE.test(encryptionKeyHex) || enc.version !== 1) return null;
  try {
    const keyBuf = Buffer.from(encryptionKeyHex, 'hex');
    const ivBuf = Buffer.from(enc.iv, 'hex');
    const authTagBuf = Buffer.from(enc.authTag, 'hex');
    const ciphertextBuf = Buffer.from(enc.ciphertext, 'hex');

    const decipher = createDecipheriv('aes-256-gcm', keyBuf, ivBuf);
    // CRITICAL: setAuthTag MUST be called BEFORE the first update() call.
    // Out-of-order produces silently-wrong output on success and "Unsupported
    // state" on failure.
    decipher.setAuthTag(authTagBuf);
    return decipher.update(ciphertextBuf, undefined, 'utf8') + decipher.final('utf8');
  } catch {
    return null;
  }
}
