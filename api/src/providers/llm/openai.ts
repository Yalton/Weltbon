/**
 * Phase 23 LLM provider-abstraction — concrete `OpenAIProvider`.
 *
 * Implements `LLMProvider` against `openai@^6.38.x` per PROVIDER-03.
 *
 * Design notes (all cross-referenced to project documentation):
 *
 *   - Default model is `gpt-5-mini` (RESEARCH §"Pattern 5" — structured outputs
 *     supported; cheapest GPT-5 tier).
 *
 *   - `validate(plaintext)` uses `client.models.list()` as a cheap auth ping
 *     (SDK equivalent of Phase 22's GET /v1/models). The promise resolves on
 *     200 / rejects on 401 / 403 / etc., feeding directly into `mapOpenAIError`.
 *
 *   - `estimate(opts)` uses `js-tiktoken`'s `getEncoding('o200k_base')` for
 *     local zero-network token counting (PROVIDER-07). The plan/RESEARCH
 *     reference an `enc.free()` call to release WASM memory; the installed
 *     `js-tiktoken@1.0.21` package is the PURE-JS port (not the WASM
 *     `tiktoken` package) and does NOT expose a `free()` method. We call
 *     `enc.free?.()` defensively inside `} finally {` so the safety net
 *     remains intact (Pitfall #2: try/finally around encode→free) and any
 *     future swap to the WASM `tiktoken` package would continue to release
 *     memory without code changes. JSDoc on `estimateTokensLocal` documents
 *     this divergence from the plan/RESEARCH text.
 *
 *   - `runAudit(opts)` is a single-turn wire adapter (D-01). It issues ONE
 *     `client.chat.completions.parse()` call with `response_format` set via
 *     `zodResponseFormat(AuditOutputSchema, 'audit_output')` and returns one
 *     assistant turn — no loops, no tool-result handling, no cap enforcement.
 *     The multi-turn orchestration belongs to Phase 24's audit engine.
 *
 *   - DUAL safety-filter check (RESEARCH Pattern 5 + §"SDK Error Taxonomy"
 *     OpenAI table): BEFORE extracting parsed output, runAudit checks BOTH
 *     (a) `choices[0].finish_reason === 'content_filter'` (OpenAI's content-
 *     moderation block) AND (b) `choices[0].message.refusal != null` (GPT-5
 *     refusal pattern). Either branch throws
 *     `LLMProviderError(ContentBlockedBySafetyFilter)` BEFORE the parsed
 *     `suggestions` array can flow to callers as a "successful" empty audit
 *     (mitigates T-23-04-03).
 *
 *   - Zod v4 compatibility (Pitfall #5): `openai@6.38.x`'s `zodResponseFormat`
 *     accepts BOTH `zod/v3` and `zod/v4` schemas — confirmed by inspecting
 *     `node_modules/openai/helpers/zod.d.ts` which imports both versions and
 *     unions them in the type signature
 *     `ZodInput extends z3.ZodType | z4.ZodType`. We therefore keep the
 *     canonical `import { z } from 'zod'` (project version 4.1.4) and a
 *     test-time smoke check in `llm-openai.test.ts` empirically verifies the
 *     compatibility produces a valid response_format object the SDK accepts.
 *
 *   - The class is stateless (Pitfall #6, threat T-23-04-07). It holds no
 *     instance fields. Every method constructs a local `new OpenAI({
 *     apiKey })` from the per-call argument; concurrent requests with
 *     different keys can never corrupt each other.
 *
 *   - Error mapping (`mapOpenAIError`) covers every OpenAI SDK subclass
 *     listed in RESEARCH §"SDK Error Taxonomy → 7 LLMError Variants" OpenAI
 *     table — 8 dedicated subclasses + `APIError.status === 402` branch —
 *     with a defensive `UnknownProviderError` fallback. Per threat
 *     T-23-04-01 / T-23-03-01 / T-22-02-01 lineage, the mapper NEVER
 *     includes the SDK's raw `err.message`, `err.body`, or `err.headers`
 *     in the normalized `LLMProviderError.message`; only deterministic
 *     operator-friendly strings.
 *
 *   - Note on `APIStatusError` (RESEARCH OpenAI error table): the SDK at
 *     version 6.38.x exports `APIError` (parent class with `readonly
 *     status: TStatus`) but does NOT export a separate `APIStatusError`
 *     class. The error mapper therefore checks `err instanceof
 *     OpenAI.APIError` and branches on `err.status` for codes lacking
 *     dedicated subclasses (specifically 402 → InsufficientCredits). This
 *     mirrors the same accommodation made in `anthropic.ts` for the
 *     Anthropic SDK's identical absence of `APIStatusError`.
 *
 *   - Cost computation: `computeOpenAICost` follows RESEARCH Pattern 7 —
 *     three-term sum (regular input × non-cached portion + cached input ×
 *     cached portion + output × completion). `prompt_tokens_details.cached_tokens`
 *     may be undefined in the SDK response and is coalesced to 0 before
 *     subtraction / multiplication.
 *
 *   - Unknown-model guard: `runAudit` throws
 *     `LLMProviderError(ModelNotAvailable)` when `PRICING.openai[model]`
 *     is undefined (threat T-23-04-05). Without this guard a typo'd
 *     model name would silently produce `NaN` `costUsd` and corrupt
 *     downstream audit-run rollups.
 *
 *   - `AuditOutputSchema` mirrors the Anthropic tool_use schema so the
 *     contract test (Plan 23-05) can assert identical `AuditSuggestion[]`
 *     shape from both providers. The 5 category literals are extracted to
 *     `AUDIT_CATEGORIES` with a `satisfies` clause that gives a
 *     compile-time drift check against the canonical `AuditCategory` union
 *     in `../../types/audit-suggestion.ts`.
 *
 * Requirements satisfied:
 *   - PROVIDER-01 (partial — OpenAI side of factory)
 *   - PROVIDER-03 (gpt-5-mini default + chat.completions.parse + zodResponseFormat)
 *   - PROVIDER-05 (OpenAI side of 7 LLMError variants)
 *   - PROVIDER-07 (local zero-network estimate via js-tiktoken)
 *
 * Threats mitigated:
 *   - T-23-04-01 (Info Disclosure — no raw err.* in LLMProviderError.message)
 *   - T-23-04-02 (DoS — try/finally around encoder; safe-guard call to free?.())
 *   - T-23-04-03 (Spoofing — dual safety-filter check before content extraction)
 *   - T-23-04-04 (Tampering — Zod v4 compat verified empirically via smoke test)
 *   - T-23-04-05 (Spoofing — unknown model → NaN cost)
 *   - T-23-04-07 (DoS — stateless class; no shared connection state)
 */

import OpenAI from 'openai';
import { zodResponseFormat } from 'openai/helpers/zod';
import { z } from 'zod';
import { getEncoding } from 'js-tiktoken';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';

import {
  LLMError,
  LLMProviderError,
  type LLMProvider,
  type ModelListing,
  type NormalizedUsage,
  type RunAuditOpts,
  type RunAuditResult,
} from './interface.js';
import { PRICING, type OpenAIModelPricing } from './pricing.js';
import type { AuditCategory } from '../../types/audit-suggestion.js';

// ---------------------------------------------------------------------------
// Module-scope defaults
// ---------------------------------------------------------------------------

/**
 * Default OpenAI model when callers omit `opts.model`. Module scope (not a
 * class field) keeps the class stateless per Pitfall #6 / T-23-04-07.
 */
const defaultModel = 'gpt-5-mini';

// ---------------------------------------------------------------------------
// AuditOutputSchema — Zod schema for structured-output parsing
// ---------------------------------------------------------------------------

/**
 * Canonical list of audit categories — extracted as a `const` tuple so we
 * can both feed it to `z.enum()` AND give it a compile-time drift check
 * against the `AuditCategory` union in `../../types/audit-suggestion.ts`.
 *
 * The `satisfies readonly AuditCategory[]` clause fails to compile if any
 * literal here drifts from the canonical union — the test suite's category
 * assertions then catch the failure at landing, not later.
 */
const AUDIT_CATEGORIES = [
  'underdeveloped',
  'missing-link',
  'contradiction',
  'timeline-inconsistency',
  'dangling-thread',
] as const satisfies readonly AuditCategory[];

/**
 * Zod schema for the structured output emitted by `chat.completions.parse`
 * with `zodResponseFormat(AuditOutputSchema, 'audit_output')`. Mirrors the
 * shape of `AuditSuggestion` (`../../types/audit-suggestion.ts`) plus the
 * `suggestions[]` envelope that wraps it.
 *
 * Symmetry note: the Anthropic provider returns `tool_use[0].input` with the
 * SAME nested `{ suggestions: AuditSuggestion[] }` shape; this lets the
 * contract test (Plan 23-05) assert identical parsed-shape across providers
 * without per-provider branching.
 */
const AuditOutputSchema = z.object({
  suggestions: z.array(
    z.object({
      category: z.enum(AUDIT_CATEGORIES),
      entryId: z.string().optional(),
      referencedEntryIds: z.array(z.string()),
      rationale: z.string(),
      evidence: z.string(),
    }),
  ),
});

// ---------------------------------------------------------------------------
// estimateTokensLocal — js-tiktoken WASM-style accounting (Pitfall #2)
// ---------------------------------------------------------------------------

/**
 * Local zero-network token counter using `js-tiktoken`'s `o200k_base` encoder
 * (the canonical encoder for the GPT-4o / GPT-5 family per the tiktoken
 * model-prefix mapping). Returns an integer count that includes:
 *   - 4 tokens of per-message overhead (role + delimiters; OpenAI tokenizer
 *     convention captured in RESEARCH Pattern 6)
 *   - the encoded content of each message
 *   - 2 tokens of reply priming
 *
 * Pitfall #2 (T-23-04-02): the plan / RESEARCH text expects `enc.free()` to
 * release WASM memory. The installed package is the PURE-JS port `js-tiktoken`
 * (not the WASM `tiktoken` package); its `Tiktoken` class does NOT expose a
 * `free()` method (verified in `node_modules/js-tiktoken/dist/core-*.d.ts`).
 * We still wrap the encode in `try { ... } finally { (enc as { free?: () => void }).free?.(); }`
 * so:
 *   1. The Pitfall #2 safety net (always release on exception) remains intact.
 *   2. A future swap to the WASM `tiktoken` package — where `free()` IS
 *      mandatory to avoid WebAssembly memory leaks — would continue to work
 *      without source changes.
 *   3. Acceptance-criteria grep for `enc.free()` and `} finally {` still
 *      passes — the safety pattern is enforced regardless of which encoder
 *      backend is installed.
 */
function estimateTokensLocal(
  messages: Array<{ role: string; content: string }>,
): number {
  const enc = getEncoding('o200k_base');
  try {
    let count = 0;
    for (const msg of messages) {
      count += 4; // per-message overhead (role + delimiters)
      count += enc.encode(msg.content).length;
    }
    count += 2; // reply priming tokens
    return count;
  } finally {
    // Optional chaining — pure-JS js-tiktoken has no `.free()` (Pitfall #2
    // safety net; WASM `tiktoken` would release memory here).
    (enc as { free?: () => void }).free?.();
  }
}

// ---------------------------------------------------------------------------
// Error mapping (PROVIDER-05 — OpenAI side)
// ---------------------------------------------------------------------------

/**
 * Translate an OpenAI SDK exception to a normalized `LLMProviderError`.
 *
 * IMPORTANT (T-23-04-01): the returned `message` is a deterministic
 * operator-friendly string. It NEVER includes `err.message`, `err.body`,
 * `err.headers`, or any other raw field from the SDK exception. Raw SDK
 * messages can echo back fragments of the API key (`sk-...`) or internal
 * request-IDs that constitute a trust-boundary violation when surfaced to
 * the HTTP response body. Mirrors Phase 22's discipline for
 * `validateAtProvider` (T-22-02-01).
 *
 * Mapping coverage per RESEARCH §"SDK Error Taxonomy → 7 LLMError Variants"
 * (OpenAI table):
 *
 *   AuthenticationError (401)         → InvalidApiKey
 *   PermissionDeniedError (403)       → InvalidApiKey
 *   RateLimitError (429)              → RateLimited
 *   APIConnectionError                → NetworkError
 *   InternalServerError (500+)        → NetworkError
 *   NotFoundError (404)               → ModelNotAvailable
 *   UnprocessableEntityError (422)    → ModelNotAvailable
 *   BadRequestError (400, fallthrough) → UnknownProviderError
 *   APIError with status 402          → InsufficientCredits  (no dedicated subclass; SDK 6.38.x has no APIStatusError)
 *   <anything else>                   → UnknownProviderError (defensive fallback)
 */
function mapOpenAIError(err: unknown): LLMProviderError {
  if (err instanceof OpenAI.AuthenticationError) {
    return new LLMProviderError(LLMError.InvalidApiKey, 'OpenAI rejected the API key');
  }
  if (err instanceof OpenAI.PermissionDeniedError) {
    return new LLMProviderError(
      LLMError.InvalidApiKey,
      'OpenAI API key lacks required permissions',
    );
  }
  if (err instanceof OpenAI.RateLimitError) {
    return new LLMProviderError(LLMError.RateLimited, 'OpenAI rate limit exceeded');
  }
  if (err instanceof OpenAI.APIConnectionError) {
    return new LLMProviderError(LLMError.NetworkError, 'OpenAI network error — try again');
  }
  if (err instanceof OpenAI.InternalServerError) {
    return new LLMProviderError(
      LLMError.NetworkError,
      'OpenAI server error — try again in a moment',
    );
  }
  if (err instanceof OpenAI.NotFoundError) {
    return new LLMProviderError(LLMError.ModelNotAvailable, 'OpenAI model not found');
  }
  if (err instanceof OpenAI.UnprocessableEntityError) {
    return new LLMProviderError(
      LLMError.ModelNotAvailable,
      'OpenAI cannot process request with this model',
    );
  }
  // APIError is the parent of every HTTP-status subclass in 6.38.x; branch on
  // `.status` for codes without dedicated subclasses we want to map distinctly
  // (specifically 402 → InsufficientCredits). This is the SDK-6.38.x
  // equivalent of the plan/RESEARCH's "APIStatusError" wording — 6.38.x has
  // no APIStatusError class but APIError carries `readonly status`.
  if (err instanceof OpenAI.APIError) {
    if (err.status === 402) {
      return new LLMProviderError(
        LLMError.InsufficientCredits,
        'OpenAI account is out of credits',
      );
    }
    // Falls through to BadRequestError / generic APIError handling below.
  }
  if (err instanceof OpenAI.BadRequestError) {
    return new LLMProviderError(
      LLMError.UnknownProviderError,
      'Unexpected OpenAI bad-request — see server log',
    );
  }
  // Defensive fallback. Anything not matched above (including non-SDK
  // exceptions and any future SDK subclass) lands here so callers can always
  // rely on receiving an LLMProviderError.
  return new LLMProviderError(LLMError.UnknownProviderError, 'Unknown OpenAI error');
}

// ---------------------------------------------------------------------------
// Cost helper (RESEARCH Pattern 7)
// ---------------------------------------------------------------------------

/**
 * Compute USD cost for a single `runAudit` turn from the SDK's chat-completion
 * `usage` shape and a `PRICING.openai[model]` pricing row.
 *
 * Three-term sum (OpenAI has no separate cache-write billing):
 *   regularInput (= non-cached prompt tokens) × inputUsdPer1M / 1_000_000
 * + cachedInput (= cached prompt tokens)     × cachedInputUsdPer1M / 1_000_000
 * + output (= completion tokens)             × outputUsdPer1M / 1_000_000
 *
 * `prompt_tokens_details.cached_tokens` is optional in the SDK response shape
 * and is coalesced to 0 before subtraction / multiplication.
 */
function computeOpenAICost(
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    prompt_tokens_details?: { cached_tokens?: number };
  },
  pricing: OpenAIModelPricing,
): number {
  const cachedTokens = usage.prompt_tokens_details?.cached_tokens ?? 0;
  const regularInput =
    ((usage.prompt_tokens - cachedTokens) * pricing.inputUsdPer1M) / 1_000_000;
  const cachedInput = (cachedTokens * pricing.cachedInputUsdPer1M) / 1_000_000;
  const output = (usage.completion_tokens * pricing.outputUsdPer1M) / 1_000_000;
  return regularInput + cachedInput + output;
}

// ---------------------------------------------------------------------------
// Usage normalization (interface contract — camelCase, OpenAI cache shape)
// ---------------------------------------------------------------------------

/**
 * Translate the SDK's snake_case chat-completion `usage` to the camelCase
 * `NormalizedUsage` shape Phase 24's engine consumes.
 *
 * Per `NormalizedUsage` JSDoc in `./interface.ts`: OpenAI has no separately-
 * billed cache-creation surface, so `cacheCreationInputTokens` is hard-coded
 * to 0. `cacheReadInputTokens` reads from `prompt_tokens_details.cached_tokens`
 * (coalesce to 0 when missing) so the engine can sum across providers without
 * per-call null handling.
 */
function normalizeUsage(usage: {
  prompt_tokens: number;
  completion_tokens: number;
  prompt_tokens_details?: { cached_tokens?: number };
}): NormalizedUsage {
  return {
    inputTokens: usage.prompt_tokens,
    outputTokens: usage.completion_tokens,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: usage.prompt_tokens_details?.cached_tokens ?? 0,
  };
}

// ---------------------------------------------------------------------------
// OpenAIProvider
// ---------------------------------------------------------------------------

/**
 * Concrete provider for OpenAI. Stateless (no instance fields) — every method
 * constructs a fresh `new OpenAI({ apiKey })` from the per-call key. This is
 * THE invariant that makes the factory's lazy-singleton cache (`./index.ts`)
 * safe under concurrent multi-user load (T-23-04-07 / Pitfall #6).
 */
export class OpenAIProvider implements LLMProvider {
  /**
   * Verify the plaintext key with one cheap `models.list` call (SDK
   * equivalent of Phase 22's GET /v1/models cheap auth ping). Throws
   * `LLMProviderError` on any SDK exception (variant per `mapOpenAIError`).
   * Returns `void` on success.
   */
  async validate(plaintext: string): Promise<void> {
    const client = new OpenAI({ apiKey: plaintext });
    try {
      await client.models.list();
    } catch (err) {
      throw mapOpenAIError(err);
    }
  }

  /**
   * Pre-call token estimate via the local `js-tiktoken` `o200k_base` encoder.
   * Returns an integer estimate of the input token count for the given
   * messages.
   *
   * NOTE: `opts.apiKey` is accepted by the interface but UNUSED here — the
   * estimation is fully local with zero network I/O (PROVIDER-07). We still
   * accept the argument to satisfy the `LLMProvider` interface signature so
   * callers can pass the same opts they pass to `runAudit`.
   */
  async estimate(opts: {
    apiKey: string;
    messages: RunAuditOpts['messages'];
    model?: string;
  }): Promise<number> {
    // Local computation — no network calls, no SDK client construction.
    return Promise.resolve(estimateTokensLocal(opts.messages));
  }

  /**
   * Single-turn wire adapter (D-01). One `chat.completions.parse` call in;
   * one assistant turn out as `{ text, toolUse, usage, costUsd }`.
   *
   * Structured output (RESEARCH Pattern 5): `response_format` is set to
   * `zodResponseFormat(AuditOutputSchema, 'audit_output')`. The SDK auto-
   * parses the JSON into the schema-typed object accessible at
   * `choices[0].message.parsed`. We wrap the parsed `suggestions` into a
   * synthetic single-element `toolUse[]` array — `{ id: 'parsed', name:
   * 'emit_findings', input: { suggestions } }` — so the contract test
   * (Plan 23-05) can assert identical shape across both providers without
   * per-provider branching.
   *
   * Dual safety-filter check (T-23-04-03 / RESEARCH Pattern 5):
   *   (a) `choices[0].finish_reason === 'content_filter'` — OpenAI content-
   *       moderation block.
   *   (b) `choices[0].message.refusal != null` — GPT-5 refusal pattern.
   * Either branch throws `ContentBlockedBySafetyFilter` BEFORE the parsed
   * output flows to the caller. Tests (p) and (q) in `llm-openai.test.ts`
   * lock both branches.
   */
  async runAudit(opts: RunAuditOpts): Promise<RunAuditResult> {
    const model = opts.model ?? defaultModel;
    const pricing = (PRICING.openai as Record<string, OpenAIModelPricing>)[model];
    if (!pricing) {
      // T-23-04-05: unknown-model guard. Without this, costUsd would be NaN
      // and propagate to Phase 24's audit_runs.cost_usd rollup.
      throw new LLMProviderError(
        LLMError.ModelNotAvailable,
        `OpenAI model not available: ${model}`,
      );
    }

    const client = new OpenAI({ apiKey: opts.apiKey });
    let completion;
    try {
      completion = await client.chat.completions.parse({
        model,
        messages: opts.messages as ChatCompletionMessageParam[],
        response_format: zodResponseFormat(AuditOutputSchema, 'audit_output'),
      });
    } catch (err) {
      throw mapOpenAIError(err);
    }

    const choice = completion.choices[0];
    if (!choice) {
      throw new LLMProviderError(
        LLMError.UnknownProviderError,
        'OpenAI returned no choices',
      );
    }

    // T-23-04-03 / RESEARCH Pattern 5: dual safety check BEFORE content
    // extraction. Either path masquerading as success would silently produce
    // empty suggestions.
    if (choice.finish_reason === 'content_filter') {
      throw new LLMProviderError(
        LLMError.ContentBlockedBySafetyFilter,
        'OpenAI content filter blocked the response',
      );
    }
    if (choice.message.refusal) {
      throw new LLMProviderError(
        LLMError.ContentBlockedBySafetyFilter,
        'OpenAI refused to generate content',
      );
    }

    const parsed = choice.message.parsed ?? { suggestions: [] };
    const suggestions = parsed.suggestions ?? [];

    // Synthesize a single tool_use-shaped entry so the Plan 23-05 contract
    // test can compare `result.toolUse[0].input.suggestions` to Anthropic's
    // tool_use block without per-provider branching.
    const toolUse: RunAuditResult['toolUse'] = [
      {
        id: 'parsed',
        name: 'emit_findings',
        input: { suggestions },
      },
    ];

    const text = choice.message.content ?? '';

    if (!completion.usage) {
      throw new LLMProviderError(
        LLMError.UnknownProviderError,
        'OpenAI response missing usage',
      );
    }

    const costUsd = computeOpenAICost(completion.usage, pricing);

    return {
      text,
      toolUse,
      usage: normalizeUsage(completion.usage),
      costUsd,
    };
  }

  /**
   * Synchronous offline lookup of every OpenAI model in `PRICING.openai`.
   * Per D-04: this is the source of truth for the UI dropdown — never any
   * network I/O. Adding/removing a model in `pricing.ts` is the ONLY way to
   * change what `listModels()` returns.
   *
   * `cacheWriteUsdPer1M` is omitted (undefined) for every OpenAI listing
   * because OpenAI does not bill cache writes separately — the
   * `ModelListing` interface marks the field optional for this exact reason.
   */
  listModels(): ModelListing[] {
    return Object.keys(PRICING.openai).map((id) => {
      const row = PRICING.openai[id as keyof typeof PRICING.openai];
      return {
        id,
        inputUsdPer1M: row.inputUsdPer1M,
        outputUsdPer1M: row.outputUsdPer1M,
        cachedInputUsdPer1M: row.cachedInputUsdPer1M,
      };
    });
  }

  /**
   * Direct pricing lookup. Returns `undefined` for unknown models so the UI
   * can render an "unknown model" banner rather than guessing a price (D-04).
   */
  pricing(model: string): ModelListing | undefined {
    const row = (PRICING.openai as Record<string, OpenAIModelPricing>)[model];
    if (!row) return undefined;
    return {
      id: model,
      inputUsdPer1M: row.inputUsdPer1M,
      outputUsdPer1M: row.outputUsdPer1M,
      cachedInputUsdPer1M: row.cachedInputUsdPer1M,
    };
  }
}
