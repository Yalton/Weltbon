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
import { and, eq } from 'drizzle-orm';
import { db as getDb } from '../db/client.js';
import { llmApiKeys, users } from '../db/schema.js';
import type { ProviderCredential } from '../providers/llm/interface.js';
import { getDecryptedKey, type LlmProvider } from './llm-key.js';
import { getConnection } from './llm-connection.js';
import {
  findSharedGrantByIdForRecipient,
  findSharedGrantForRecipient,
  SHARED_LLM_POLICY_VERSION,
  type SharedProvider,
} from './llm-sharing.js';
import { decryptSecret } from './crypto.js';

/** Providers configured by endpoint rather than by secret. */
const ENDPOINT_PROVIDERS: ReadonlySet<LlmProvider> = new Set(['ollama']);

export type EffectiveLlmCredential = {
  credential: ProviderCredential;
  source: 'own' | 'shared';
  credentialOwnerId: string;
  keyId: string;
  sharedGrantId: string | null;
};

export type EffectiveCredentialResult =
  | { kind: 'ready'; value: EffectiveLlmCredential }
  | { kind: 'missing' }
  | { kind: 'consent_required'; grantId: string }
  | { kind: 'unavailable'; source: 'own' | 'shared' };

export type StoredSharedCredentialResult =
  | { kind: 'ready'; credential: ProviderCredential }
  | { kind: 'revoked' }
  | { kind: 'unavailable' };

function isSharedProvider(provider: LlmProvider): provider is SharedProvider {
  return provider === 'anthropic' || provider === 'openai';
}

function decryptApiKey(
  key: typeof llmApiKeys.$inferSelect,
  encryptionKeyHex: string | undefined,
): string | null {
  if (encryptionKeyHex === undefined) return null;
  return decryptSecret({
    ciphertext: key.ciphertext,
    iv: key.iv,
    authTag: key.authTag,
    bodySuffix: key.bodySuffix,
    version: key.encryptedKeyVersion as 1,
  }, encryptionKeyHex);
}

async function getExactOwnerKey(
  ownerUserId: string,
  ownerKeyId: string,
  provider: SharedProvider,
) {
  const [key] = await getDb().select().from(llmApiKeys).where(and(
    eq(llmApiKeys.id, ownerKeyId),
    eq(llmApiKeys.userId, ownerUserId),
    eq(llmApiKeys.provider, provider),
  )).limit(1);
  return key ?? null;
}

async function isActiveAdministrator(userId: string): Promise<boolean> {
  const [owner] = await getDb().select({
    isAdmin: users.isAdmin,
    disabledAt: users.disabledAt,
  }).from(users).where(eq(users.id, userId)).limit(1);
  return owner?.isAdmin === true && owner.disabledAt === null;
}

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

/**
 * Resolves the hosted credential a recipient may use right now. Personal rows
 * are checked first and their presence blocks shared fallback even if they
 * cannot be decrypted, preventing an unexpected billing-owner switch.
 */
export async function resolveEffectiveCredential(
  userId: string,
  provider: LlmProvider,
  encryptionKeyHex: string | undefined,
): Promise<EffectiveCredentialResult> {
  if (isEndpointProvider(provider) || !isSharedProvider(provider)) return { kind: 'missing' };

  const [ownKey] = await getDb().select().from(llmApiKeys).where(and(
    eq(llmApiKeys.userId, userId),
    eq(llmApiKeys.provider, provider),
  )).limit(1);
  if (ownKey) {
    const apiKey = decryptApiKey(ownKey, encryptionKeyHex);
    if (apiKey === null) return { kind: 'unavailable', source: 'own' };
    return {
      kind: 'ready',
      value: {
        credential: { apiKey },
        source: 'own',
        credentialOwnerId: userId,
        keyId: ownKey.id,
        sharedGrantId: null,
      },
    };
  }

  const grant = await findSharedGrantForRecipient(userId, provider);
  if (!grant) return { kind: 'missing' };
  if (grant.consentedAt === null || grant.policyVersion !== SHARED_LLM_POLICY_VERSION) {
    return { kind: 'consent_required', grantId: grant.id };
  }
  if (!await isActiveAdministrator(grant.ownerUserId)) return { kind: 'unavailable', source: 'shared' };

  const ownerKey = await getExactOwnerKey(grant.ownerUserId, grant.ownerKeyId, provider);
  if (!ownerKey) return { kind: 'unavailable', source: 'shared' };
  const apiKey = decryptApiKey(ownerKey, encryptionKeyHex);
  if (apiKey === null) return { kind: 'unavailable', source: 'shared' };
  return {
    kind: 'ready',
    value: {
      credential: { apiKey },
      source: 'shared',
      credentialOwnerId: grant.ownerUserId,
      keyId: ownerKey.id,
      sharedGrantId: grant.id,
    },
  };
}

/**
 * Resolves a credential for an existing shared audit from its persisted grant
 * only. It intentionally never considers the recipient's current own key.
 */
export async function resolveSharedGrantCredential(
  recipientUserId: string,
  grantId: string,
  provider: LlmProvider,
  encryptionKeyHex: string | undefined,
): Promise<StoredSharedCredentialResult> {
  if (isEndpointProvider(provider) || !isSharedProvider(provider)) return { kind: 'revoked' };

  const grant = await findSharedGrantByIdForRecipient(recipientUserId, grantId);
  if (!grant || grant.provider !== provider) return { kind: 'revoked' };
  if (grant.consentedAt === null || grant.policyVersion !== SHARED_LLM_POLICY_VERSION) {
    return { kind: 'revoked' };
  }
  if (!await isActiveAdministrator(grant.ownerUserId)) return { kind: 'revoked' };

  const ownerKey = await getExactOwnerKey(grant.ownerUserId, grant.ownerKeyId, provider);
  if (!ownerKey) return { kind: 'revoked' };
  const apiKey = decryptApiKey(ownerKey, encryptionKeyHex);
  return apiKey === null ? { kind: 'unavailable' } : { kind: 'ready', credential: { apiKey } };
}
