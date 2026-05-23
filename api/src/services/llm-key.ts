/**
 * Phase 22 BYOK — LLM API key encryption + provider validation.
 *
 * Three exports consumed by Plan 22-04 (routes) and Phase 23 (provider abstraction):
 *
 *   - encryptKey(plaintext, encryptionKeyHex):
 *       AES-256-GCM with per-call random 12-byte IV + 16-byte auth tag.
 *       Pure function. Returns hex-encoded { ciphertext, iv, authTag, bodySuffix, version: 1 }.
 *
 *   - getDecryptedKey(userId, provider):
 *       Per-call DB read + decrypt. Returns string | null where null covers FOUR cases
 *       (D-11): no row, decryption failure, missing LLM_KEY_ENCRYPTION_KEY env var, or
 *       malformed (non-64-hex) env var. Caller cannot distinguish — treat null as
 *       "no usable key". No cache anywhere (D-10).
 *
 *   - validateAtProvider(plaintext, provider):
 *       Single 5s-timeout HTTP ping to Anthropic count_tokens or OpenAI models.list.
 *       Throws ProviderValidationError with kind ∈ { rejected | transient | timeout }.
 *
 * Trust boundary discipline (T-22-02-01, T-22-02-02, T-22-02-06):
 *   - No console.log / console.info / console.error in this module.
 *   - The single permitted console.warn line is metadata-only — never references
 *     plaintext, ciphertext, iv, authTag, encryptionKeyHex, keyBuf, or err.message.
 *   - Thrown ProviderValidationError messages never echo the plaintext or the
 *     provider's response body (D-03).
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

export class ProviderValidationError extends Error {
  public readonly kind: 'rejected' | 'transient' | 'timeout';
  constructor(message: string, kind: 'rejected' | 'transient' | 'timeout') {
    super(message);
    this.name = 'ProviderValidationError';
    this.kind = kind;
  }
}

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

// ---------------------------------------------------------------------------
// validateAtProvider
// ---------------------------------------------------------------------------

const ANTHROPIC_PING_URL = 'https://api.anthropic.com/v1/messages/count_tokens';
const ANTHROPIC_PING_MODEL = 'claude-haiku-4-5';
const OPENAI_PING_URL = 'https://api.openai.com/v1/models';

const PROVIDER_DISPLAY: Record<LlmProvider, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
};

/**
 * Issue a single 5s-timeout ping to the provider with the given plaintext key.
 *
 * D-02: no retry — exactly one fetch. Strict-state save model (D-01) makes
 * manual retry the user's responsibility on transient failures.
 *
 * Status mapping (per <validate_contract>):
 *   2xx              → void (success)
 *   401 / 403        → throw rejected (provider unambiguously says "bad key")
 *   400 + provider-flagged auth error in JSON body → rejected
 *   400 (other)      → transient (likely malformed request — caller bug worth retry)
 *   429 / 5xx        → transient
 *   AbortError / TimeoutError → timeout
 *   Network error    → transient
 *   Other            → transient (defensive default)
 *
 * The plaintext never appears in the thrown message. The provider's response
 * body is consumed ONLY on the 400 branch (needed for the error-type/code
 * check); for 401/403 we never read the body (D-03 — could contain echoed
 * key fragments in a misformatted provider response).
 */
export const validateAtProvider = async (
  plaintext: string,
  provider: LlmProvider,
): Promise<void> => {
  const display = PROVIDER_DISPLAY[provider];

  // D-02: exactly one timer per validate call, no retry.
  const signal = AbortSignal.timeout(5000);

  let url: string;
  let init: RequestInit;
  if (provider === 'anthropic') {
    url = ANTHROPIC_PING_URL;
    init = {
      method: 'POST',
      headers: {
        'x-api-key': plaintext,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: ANTHROPIC_PING_MODEL,
        messages: [{ role: 'user', content: 'hi' }],
      }),
      signal,
    };
  } else {
    url = OPENAI_PING_URL;
    init = {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${plaintext}`,
      },
      signal,
    };
  }

  let res: Response;
  try {
    res = await fetch(url, init);
  } catch (err: unknown) {
    const name = (err as { name?: string } | null)?.name;
    if (name === 'AbortError' || name === 'TimeoutError') {
      throw new ProviderValidationError(
        `${display} did not respond within 5 seconds — try again.`,
        'timeout',
      );
    }
    throw new ProviderValidationError(
      `${display} returned a network error — try again in a moment.`,
      'transient',
    );
  }

  if (res.ok) {
    return;
  }

  if (res.status === 401 || res.status === 403) {
    throw new ProviderValidationError(
      `${display} rejected this key as invalid — check the key and try again.`,
      'rejected',
    );
  }

  if (res.status === 400) {
    // The ONLY branch that reads the body — needed to distinguish "bad key shape"
    // from "malformed request". We never include the body content in the thrown
    // message; only inspect the well-known error-type / error-code fields.
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      // Provider returned 400 without JSON — treat as transient (malformed body).
    }
    if (provider === 'anthropic') {
      const errType = (body as { error?: { type?: string } } | null)?.error?.type;
      if (errType === 'authentication_error') {
        throw new ProviderValidationError(
          `${display} rejected this key as invalid — check the key and try again.`,
          'rejected',
        );
      }
    } else {
      const errCode = (body as { error?: { code?: string } } | null)?.error?.code;
      if (errCode === 'invalid_api_key') {
        throw new ProviderValidationError(
          `${display} rejected this key as invalid — check the key and try again.`,
          'rejected',
        );
      }
    }
    throw new ProviderValidationError(
      `${display} returned ${res.status} — try again in a moment.`,
      'transient',
    );
  }

  if (res.status === 429 || res.status >= 500) {
    throw new ProviderValidationError(
      `${display} returned ${res.status} — try again in a moment.`,
      'transient',
    );
  }

  // Defensive default — unexpected status, treat as transient.
  throw new ProviderValidationError(
    `${display} returned ${res.status} — try again in a moment.`,
    'transient',
  );
};
