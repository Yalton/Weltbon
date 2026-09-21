/**
 * Endpoint-based LLM providers (#48) — storage for connections configured by
 * base URL rather than by secret (e.g. a self-hosted Ollama server).
 *
 * Companion to `llm-key.ts` (API-key providers): kept as a separate module
 * because `llm_connections` rows carry an OPTIONAL secret (see schema.ts),
 * so every read must tolerate a null ciphertext — a case `llm-key.ts`'s
 * NOT NULL columns never have to handle.
 *
 * Trust boundary discipline (mirrors llm-key.ts): no console.log / console.info
 * / console.error in this module, and never log a base URL alongside a secret.
 */
import { and, eq } from 'drizzle-orm';
import { db as getDb } from '../db/client.js';
import { llmConnections } from '../db/schema.js';
import { encryptSecret, decryptSecret, type EncryptedSecret } from './crypto.js';

export interface ConnectionRow {
  id: string;
  userId: string;
  provider: string;
  baseUrl: string;
  label: string;
  secret: string | null;
  lastValidatedAt: Date | null;
}

export async function getConnection(
  userId: string,
  provider: string,
  encryptionKeyHex?: string,
): Promise<ConnectionRow | null> {
  const [row] = await getDb()
    .select()
    .from(llmConnections)
    .where(and(eq(llmConnections.userId, userId), eq(llmConnections.provider, provider)))
    .limit(1);
  if (!row) return null;

  let secret: string | null = null;
  // not a secret. Fall back to null rather than throwing.
  if (row.ciphertext && row.iv && row.authTag && row.bodySuffix && encryptionKeyHex) {
    secret = decryptSecret(
      {
        ciphertext: row.ciphertext,
        iv: row.iv,
        authTag: row.authTag,
        bodySuffix: row.bodySuffix,
        version: 1,
      } satisfies EncryptedSecret,
      encryptionKeyHex,
    );
  }

  return {
    id: row.id,
    userId: row.userId,
    provider: row.provider,
    baseUrl: row.baseUrl,
    label: row.label,
    secret,
    lastValidatedAt: row.lastValidatedAt,
  };
}

export async function upsertConnection(
  userId: string,
  provider: string,
  baseUrl: string,
  label = '',
  secretPlaintext?: string,
  encryptionKeyHex?: string,
): Promise<ConnectionRow> {
  // fall through to `enc = null` below — the row was written with the secret
  // caller that can ever pass a secret, and its own 503 gate normally keeps
  // caller that does not know about that landmine. An empty-string
  // secretPlaintext ('' — "clear the secret") is intentionally NOT covered:
  // which is the correct "no secret" result, not a failure to encrypt one.
  if (secretPlaintext && !encryptionKeyHex) {
    throw new Error(
      'upsertConnection: a secret was provided but no encryption key is configured — refusing to silently drop it',
    );
  }

  const enc =
    secretPlaintext && encryptionKeyHex
      ? encryptSecret(secretPlaintext, encryptionKeyHex)
      : null;

  const values = {
    userId,
    provider,
    baseUrl,
    label,
    ciphertext: enc?.ciphertext ?? null,
    iv: enc?.iv ?? null,
    authTag: enc?.authTag ?? null,
    bodySuffix: enc?.bodySuffix ?? null,
    encryptedKeyVersion: enc ? 1 : null,
  };

  await getDb()
    .insert(llmConnections)
    .values(values)
    .onConflictDoUpdate({
      target: [llmConnections.userId, llmConnections.provider],
      set: { ...values, lastValidatedAt: null },
    });

  const row = await getConnection(userId, provider, encryptionKeyHex);
  if (row === null) throw new Error('connection vanished immediately after upsert');
  return row;
}

export async function deleteConnection(userId: string, provider: string): Promise<boolean> {
  const deleted = await getDb()
    .delete(llmConnections)
    .where(and(eq(llmConnections.userId, userId), eq(llmConnections.provider, provider)))
    .returning({ id: llmConnections.id });
  return deleted.length > 0;
}
