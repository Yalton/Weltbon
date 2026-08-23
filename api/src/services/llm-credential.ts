/**
 * #48 — the single place the `llm_api_keys` table and the `llm_connections`
 * table meet.
 *
 * Before this module, every credential-taking call site had to know for
 * itself whether a given provider is key-based (Anthropic, OpenAI —
 * `getDecryptedKey`) or endpoint-based (Ollama — Task 1's `getConnection`).
 * `resolveCredential` collapses that branch into one function so callers
 * (the audit engine, and eventually the BYOK routes) never re-derive it.
 *
 * Trust boundary discipline (mirrors llm-key.ts / llm-connection.ts): no
 * console.log / console.info / console.error in this module, and never log
 * a secret or a base URL alongside one.
 */
import type { ProviderCredential } from '../providers/llm/interface.js';
import { getDecryptedKey, type LlmProvider } from './llm-key.js';
import { getConnection } from './llm-connection.js';

/** Providers configured by endpoint rather than by secret. */
const ENDPOINT_PROVIDERS: ReadonlySet<LlmProvider> = new Set(['ollama']);

/**
 * Is this provider configured by endpoint (llm_connections) rather than by
 * secret (llm_api_keys)?
 *
 * Exported because callers outside the credential resolution itself have to
 * branch on it: a route that must produce a DIFFERENT error message, or skip a
 * key lookup entirely, cannot get that from `resolveCredential`'s deliberately
 * collapsed null. Fix round 2 (#48 whole-branch review, Critical 1) made this
 * shared rather than re-derived: `routes/llm-models.ts` had its own copy and
 * `routes/audits.ts` had none at all, which is exactly how the estimate route
 * came to resolve an API key for a provider that can never have one — a
 * permanent 400 that disabled the Run button for every Ollama universe.
 */
export function isEndpointProvider(provider: LlmProvider): boolean {
  return ENDPOINT_PROVIDERS.has(provider);
}

/**
 * The single place the key table and the connection table meet.
 *
 * Returns null for "no usable credential", preserving getDecryptedKey's
 * four-case null contract (Phase 22 D-11) — the engine maps null to
 * markFailed(PROVIDER_ERROR), so null must keep meaning exactly that. For
 * ollama, "no connection row" is the analogous fifth case: same meaning
 * ("nothing this run can authenticate with"), same null return, so the
 * engine's existing branch handles it with no changes.
 */
export async function resolveCredential(
  userId: string,
  provider: LlmProvider,
  encryptionKeyHex: string | undefined,
): Promise<ProviderCredential | null> {
  if (ENDPOINT_PROVIDERS.has(provider)) {
    const conn = await getConnection(userId, provider, encryptionKeyHex);
    if (conn === null) return null;
    return conn.secret === null
      ? { baseUrl: conn.baseUrl }
      : { baseUrl: conn.baseUrl, secret: conn.secret };
  }

  const apiKey = await getDecryptedKey(userId, provider, encryptionKeyHex);
  return apiKey === null ? null : { apiKey };
}
