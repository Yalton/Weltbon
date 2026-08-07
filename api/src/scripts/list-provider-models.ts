/**
 * One-shot diagnostic: list the model IDs the provider's API actually accepts
 * for a given user's BYOK key. Compares the live list against the in-repo
 * PRICING constant and reports missing/extra entries.
 *
 * Usage:
 *   pnpm tsx --env-file=../.env src/scripts/list-provider-models.ts <email> [provider]
 *
 * Where:
 *   email     — user whose BYOK key to use
 *   provider  — 'anthropic' (default) | 'openai'
 *
 * Reads:
 *   - LLM_KEY_ENCRYPTION_KEY from env (decrypts the stored key)
 *   - llm_api_keys row for (user, provider)
 *   - PRICING constant for reconciliation
 *
 * Does not write anything. Pure diagnostic.
 */

import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { eq } from 'drizzle-orm';
import { db, closeDb } from '../db/client.js';
import { users } from '../db/schema.js';
import { getDecryptedKey } from '../services/llm-key.js';
import { PRICING } from '../providers/llm/pricing.js';

type ProviderName = 'anthropic' | 'openai';

async function listAnthropicModels(apiKey: string): Promise<string[]> {
  const client = new Anthropic({ apiKey });
  const ids: string[] = [];
  for await (const m of client.models.list({ limit: 100 })) {
    ids.push(m.id);
  }
  return ids;
}

async function listOpenAIModels(apiKey: string): Promise<string[]> {
  const client = new OpenAI({ apiKey });
  const ids: string[] = [];
  for await (const m of client.models.list()) {
    ids.push(m.id);
  }
  return ids;
}

async function main() {
  const email = process.argv[2];
  const provider = (process.argv[3] ?? 'anthropic') as ProviderName;

  if (!email) {
    console.error('Usage: tsx src/scripts/list-provider-models.ts <email> [provider]');
    process.exit(1);
  }
  if (provider !== 'anthropic' && provider !== 'openai') {
    console.error(`Unknown provider '${provider}' — expected 'anthropic' or 'openai'`);
    process.exit(1);
  }

  const userRows = await db().select().from(users).where(eq(users.email, email)).limit(1);
  if (userRows.length === 0) {
    console.error(`No user with email '${email}'`);
    process.exit(1);
  }
  const userId = userRows[0].id;

  const encryptionKey = process.env.LLM_KEY_ENCRYPTION_KEY;
  const plaintext = await getDecryptedKey(userId, provider, encryptionKey);
  if (plaintext === null) {
    console.error(`No decryptable ${provider} key for ${email} (user ${userId})`);
    process.exit(1);
  }

  console.log(`Listing ${provider} models for ${email}...`);
  console.log('');

  const liveIds =
    provider === 'anthropic'
      ? await listAnthropicModels(plaintext)
      : await listOpenAIModels(plaintext);

  const pricedIds = Object.keys(PRICING[provider]);
  const liveSet = new Set(liveIds);
  const pricedSet = new Set(pricedIds);

  const inPricingMissingLive = pricedIds.filter((id) => !liveSet.has(id));
  const inLiveMissingPricing = liveIds.filter((id) => !pricedSet.has(id));

  console.log(`=== Live models from ${provider} API (${liveIds.length} total) ===`);
  for (const id of liveIds.sort()) console.log(`  ${id}`);
  console.log('');

  console.log(`=== In-repo PRICING (${pricedIds.length} total) ===`);
  for (const id of pricedIds.sort()) console.log(`  ${id}`);
  console.log('');

  if (inPricingMissingLive.length > 0) {
    console.log(`!!! IN PRICING BUT NOT IN LIVE LIST (${inPricingMissingLive.length}) !!!`);
    console.log('    These IDs will fail at runtime — Anthropic/OpenAI will return 404.');
    for (const id of inPricingMissingLive) console.log(`  - ${id}`);
    console.log('');
  } else {
    console.log('OK: every PRICING ID is present in the live list.');
    console.log('');
  }

  if (inLiveMissingPricing.length > 0) {
    console.log(`(info) In live list but not priced (${inLiveMissingPricing.length}):`);
    for (const id of inLiveMissingPricing) console.log(`  - ${id}`);
    console.log('');
  }

  await closeDb();
}

main().catch((err) => {
  console.error('list-provider-models failed:', err);
  process.exit(1);
});
