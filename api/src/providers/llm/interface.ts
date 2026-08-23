/**
 * Phase 23 LLM provider-abstraction interface.
 *
 * This module is the contract surface Phase 24's audit engine consumes. Per D-05a,
 * Phase 24 imports ONLY from this file and `./index.js` — never the concrete
 * `AnthropicProvider` / `OpenAIProvider` classes — and uses just five symbols
 * across the trust boundary:
 *
 *   - LLMProvider           (the abstract surface)
 *   - LLMError              (normalized error variants)
 *   - LLMProviderError      (typed-error carrier with `variant` discriminant)
 *   - getProvider           (factory, from `./index.js`)
 *   - PRICING / PRICING_AS_OF (from `./pricing.js`, Phase 23-02)
 *
 * Trust boundary discipline (T-23-01-01, mirrors Phase 22 T-22-02-01):
 *   - `LLMProviderError.message` MUST be a normalized human-readable string —
 *     callers (route handlers, audit engine) may echo it to the HTTP body.
 *     Per-provider implementations (Plans 23-03 / 23-04) MUST NOT include
 *     plaintext API keys, raw SDK error bodies, or echoed user content in
 *     `message`. The route layer is allowed to map `variant` → status code
 *     and surface `message` as the response body without further sanitization.
 *
 * Decisions governing this file:
 *   - D-01: `runAudit` is a single-turn wire adapter — one assistant turn out,
 *           never a loop. The multi-turn tool-use orchestration lives in Phase 24.
 *   - D-02: `AuditSuggestion` (in `../../types/audit-suggestion.js`) is the
 *           minimal provider-emitted stub; Phase 24 extends with engine fields.
 *   - D-04: `listModels()` returns pricing-backed model listings — offline,
 *           deterministic, never any network I/O.
 *   - D-05 / D-05a: file lives at `api/src/providers/llm/interface.ts`; only
 *           the symbols listed above cross the Phase 23 → Phase 24 boundary.
 *
 * Requirements:
 *   - PROVIDER-01: the five-method `LLMProvider` interface shape
 *   - PROVIDER-05: the seven-variant `LLMError` enum + typed `LLMProviderError`
 *
 * No runtime imports — pure type / value declarations.
 */

import type { AuditSuggestion } from '../../types/audit-suggestion.js';

// ---------------------------------------------------------------------------
// ProviderCredential (#48 — Ollama as a local LLM provider, Task 3)
// ---------------------------------------------------------------------------

/**
 * What a provider needs to talk to its backend.
 *
 * One object rather than an `apiKey` string plus an optional `baseUrl`: with two
 * parameters, every call site has to know which combination is valid for which
 * provider — two things that must agree forever. Validity is a provider concern
 * and is checked in one place.
 */
export interface ProviderCredential {
  /** Key-based providers (anthropic, openai). */
  apiKey?: string;
  /** Endpoint-based providers (ollama). */
  baseUrl?: string;
  /** Optional bearer for an endpoint behind an authenticating proxy. */
  secret?: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Minimum prompt-cache eligibility threshold for the Anthropic Haiku 4.5 family.
 *
 * Sourced from the Anthropic prompt-caching documentation (RESEARCH §"Anthropic
 * Cache Threshold", citing platform.claude.com/docs/en/build-with-claude/prompt-caching):
 * cache breakpoints are only honored when the cached prefix is ≥ this many tokens.
 * Smaller prefixes silently fall back to non-cached billing — wiring cache_control
 * onto a sub-threshold prefix wastes the API call's cache-breakpoint budget for no
 * billing benefit.
 *
 * Phase 23-03 (`AnthropicProvider`) applies `cache_control: { type: 'ephemeral' }`
 * to the static-digest prefix only when its estimated token count is ≥ this value.
 *
 * Threat T-23-01-02 (Tampering): the value is a build-time constant; not user-
 * influenced; `accept` disposition per the plan threat model.
 */
export const MIN_CACHEABLE_TOKENS = 4096;

// ---------------------------------------------------------------------------
// Error taxonomy (PROVIDER-05)
// ---------------------------------------------------------------------------

/**
 * Normalized provider-error variants exposed across the Phase 23 → Phase 24
 * boundary. The engine (Phase 24) and the UI banner-copy table (Phase 26) MUST
 * branch only on these seven variants — never on raw SDK error subclasses or
 * provider-specific HTTP status codes.
 *
 * String-valued members so `JSON.stringify({ variant: err.variant })` produces
 * readable diagnostic output for logs and audit-run records.
 *
 * Mapping (per D-03, defined per-provider in Plans 23-03 / 23-04):
 *   Anthropic.AuthenticationError / OpenAI.AuthenticationError → InvalidApiKey
 *   Anthropic.RateLimitError      / OpenAI.RateLimitError       → RateLimited
 *   Anthropic.PermissionDeniedError (insufficient_quota)        → InsufficientCredits
 *   OpenAI.PermissionDeniedError (insufficient_quota / billing) → InsufficientCredits
 *   Anthropic.NotFoundError       / OpenAI.NotFoundError        → ModelNotAvailable
 *   Anthropic content-policy refusal / OpenAI safety filter     → ContentBlockedBySafetyFilter
 *   APIConnectionError / APIConnectionTimeoutError              → NetworkError
 *   everything else                                              → UnknownProviderError
 */
export enum LLMError {
  RateLimited = 'RateLimited',
  InvalidApiKey = 'InvalidApiKey',
  InsufficientCredits = 'InsufficientCredits',
  ModelNotAvailable = 'ModelNotAvailable',
  ContentBlockedBySafetyFilter = 'ContentBlockedBySafetyFilter',
  NetworkError = 'NetworkError',
  UnknownProviderError = 'UnknownProviderError',
}

/**
 * Single typed-error carrier emitted by every `LLMProvider` method.
 *
 * Pattern mirrors Phase 22's `ProviderValidationError` (services/llm-key.ts
 * lines 47-54): `extends Error` + readonly discriminant + explicit `this.name`.
 * The discriminant is `variant: LLMError` (string-valued enum), so consumers
 * can use either `err instanceof LLMProviderError` AND `err.variant === ...`
 * checks, or a `switch (err.variant)` after the `instanceof` guard.
 *
 * Constructor argument order is `(variant, message)` — variant first so call
 * sites read as "this is an InvalidApiKey error with the following message".
 *
 * T-23-01-01: the `message` MUST be a pre-normalized human-readable string;
 * concrete providers (Plans 23-03 / 23-04) are responsible for the trust-
 * boundary discipline. Route handlers may surface `message` directly in the
 * HTTP response body.
 */
export class LLMProviderError extends Error {
  public readonly variant: LLMError;
  constructor(variant: LLMError, message: string) {
    super(message);
    this.name = 'LLMProviderError';
    this.variant = variant;
  }
}

// ---------------------------------------------------------------------------
// Shared types (consumed by `LLMProvider` and downstream Phase 24 engine)
// ---------------------------------------------------------------------------

/**
 * Normalized post-call usage figures returned by `runAudit`. Cache fields are
 * Anthropic-specific; OpenAI providers MUST populate them as 0 (zero) so the
 * engine can sum the four fields without per-provider branching.
 *
 * `inputTokens` and `outputTokens` are mutually exclusive of the cache fields
 * for Anthropic — cached reads do NOT also count toward `inputTokens` (per the
 * Anthropic billing docs). Phase 24's cost rollup must NOT double-count.
 */
export interface NormalizedUsage {
  inputTokens: number;
  outputTokens: number;
  /** 0 for OpenAI providers (no equivalent surface). */
  cacheCreationInputTokens: number;
  /** 0 for OpenAI providers (no equivalent surface). */
  cacheReadInputTokens: number;
}

/**
 * Listing entry returned by `listModels()` and `pricing(model)`.
 *
 * `inputUsdPer1M` / `outputUsdPer1M` are required for every model. The two
 * optional fields (`cachedInputUsdPer1M`, `cacheWriteUsdPer1M`) are Anthropic-
 * specific; OpenAI listings leave them undefined (D-04, RESEARCH §PRICING
 * Constant Shape).
 */
export interface ModelListing {
  id: string;
  inputUsdPer1M: number;
  outputUsdPer1M: number;
  /** Anthropic only — cost per 1M tokens read from prompt cache. */
  cachedInputUsdPer1M?: number;
  /** Anthropic only — cost per 1M tokens written into prompt cache. */
  cacheWriteUsdPer1M?: number;
}

/**
 * Phase 27 D-05 wire shape: a single entry in the live-list response.
 *
 * `id` is the provider-emitted model id. `hasPricing` reflects whether
 * the id is present in `PRICING[provider]`; when `true`, `pricing` is the
 * full `ModelListing` row. When `false`, `pricing` is undefined and the UI
 * renders a `⚠ no pricing` chip next to the id (the model is still selectable).
 *
 * This is NOT a subtype of `ModelListing` — Phase 27 D-04 revision: live API
 * is the catalog, PRICING is the cost lookup, so the catalog row exposes the
 * id + coverage flag and the pricing row hangs off it.
 */
export interface ModelListingWithCoverage {
  id: string;
  hasPricing: boolean;
  pricing?: ModelListing;
}

/**
 * Phase 27 D-01/D-02 wire shape: the cache + fallback result envelope.
 *
 * `source` discriminates which path produced the listing:
 *   - 'live'             — fresh provider response (cache miss + success) OR
 *                          a still-fresh cached entry (within 30-min TTL).
 *   - 'cache_stale'      — provider SDK threw AND a cached entry existed for
 *                          this `(provider, keyId)`; returned regardless of TTL.
 *   - 'pricing_fallback' — provider SDK threw AND no cached entry existed;
 *                          synthesized from `Object.keys(PRICING[provider])`.
 *
 * `fetchedAt` is an ISO8601 UTC string; for fallback paths it is the timestamp
 * of the cached entry (cache_stale) or `new Date().toISOString()` at synthesis
 * time (pricing_fallback). The frontend uses `source` to render an optional
 * "live list unavailable" indicator; `fetchedAt` powers debug surfaces only.
 */
export interface ListingsResult {
  models: ModelListingWithCoverage[];
  source: 'live' | 'cache_stale' | 'pricing_fallback';
  fetchedAt: string;
}

/**
 * Single-turn audit invocation inputs.
 *
 * RESEARCH Pitfall #6: `credential` is passed per-call, NEVER held as instance
 * state on the provider. Phase 24's engine resolves the user's credential
 * (#48 `resolveCredential`, which wraps Phase 22 `getDecryptedKey` for
 * key-based providers and Task 1's `getConnection` for endpoint-based ones)
 * once per audit run and passes it here; providers MUST construct a fresh
 * SDK / HTTP client inside the method body.
 *
 * `messages` uses a structural union acceptable to both SDKs; the concrete
 * provider re-shapes internally (Anthropic moves `system` out of the array,
 * OpenAI keeps it inline).
 *
 * `tools` is `unknown[]` because the JSONSchema shape Phase 24 emits differs
 * between providers (Anthropic `input_schema` vs OpenAI `function.parameters`);
 * Phase 24's tool-shaping helper produces the right per-provider shape.
 */
export interface RunAuditOpts {
  credential: ProviderCredential;
  messages: Array<{ role: 'system' | 'user' | 'assistant' | 'tool'; content: string }>;
  model?: string;
  tools?: unknown[];
}

/**
 * Single-turn audit invocation output — one assistant turn worth of content.
 *
 * Per D-01 this is the wire-adapter contract: one SDK call in, one assistant
 * turn out. Multi-turn loops, tool execution, and cap enforcement live in
 * Phase 24's engine (which calls `runAudit` repeatedly with growing `messages`).
 *
 * `text` may be empty (when the assistant only emits tool calls). `toolUse`
 * may be empty (when the assistant only emits text). At least one of the two
 * SHOULD be non-empty on a successful call.
 *
 * `usage` is the normalized usage for THIS single turn only — Phase 24
 * accumulates across turns when rolling up audit-run totals.
 *
 * `costUsd` is computed by the provider from `usage` × `PRICING[model]`;
 * exposing it pre-computed is convenient for the engine's hard-cap check.
 */
export interface RunAuditResult {
  text: string;
  toolUse: Array<{ id: string; name: string; input: Record<string, unknown> }>;
  usage: NormalizedUsage;
  costUsd: number;
}

// ---------------------------------------------------------------------------
// LLMProvider interface (PROVIDER-01)
// ---------------------------------------------------------------------------

/**
 * The provider-abstraction surface. Five methods, no more (PROVIDER-01).
 *
 * Implementations (Plans 23-03 / 23-04) construct provider SDK clients
 * INSIDE each method using the per-call `credential` argument (#48
 * `ProviderCredential`) — no constructor arguments, no instance state
 * holding plaintext (RESEARCH Pitfall #6).
 *
 * The interface is deliberately small: Phase 24's engine reaches across the
 * boundary five times per audit (validate once at key save, estimate once
 * for the pre-run cost surface, runAudit N times per turn, listModels /
 * pricing for the UI dropdown). Everything else stays provider-internal.
 */
export interface LLMProvider {
  /**
   * Verify the credential by issuing one cheap network call to the provider.
   * Throws `LLMProviderError(InvalidApiKey, …)` if the provider unambiguously
   * rejects the key, or `LLMProviderError(NetworkError, …)` /
   * `LLMProviderError(UnknownProviderError, …)` for transient or unclassified
   * failures. Returns `void` on success.
   *
   * Phase 22's `validateAtProvider` is replaced by this method per D-03.
   * Route handlers (`api/src/routes/llm-keys.ts`) catch `LLMProviderError`
   * and map `variant === InvalidApiKey → 422`, everything else → `503`.
   */
  validate(credential: ProviderCredential): Promise<void>;

  /**
   * Pre-call token estimate for the given messages. Implementations use free /
   * local methods only (PROVIDER-07):
   *   - Anthropic: `messages.countTokens()` (zero-billed)
   *   - OpenAI:    `js-tiktoken` with `o200k_base` encoder (local, no network)
   *
   * Returns an integer estimate of the input token count. Phase 24 / Phase 26
   * multiply this by `PRICING[provider][model].inputUsdPer1M / 1_000_000` for
   * the pre-run cost-range UI.
   *
   * When the caller has a system prompt, it MUST be passed via the optional
   * `system` field rather than as a role:'system' entry inside `messages` —
   * providers requiring a top-level system parameter (Anthropic) rely on this
   * separation to avoid SDK 400s, and providers that accept inline system
   * (OpenAI) treat it as additive to the token count.
   */
  estimate(opts: {
    credential: ProviderCredential;
    messages: RunAuditOpts['messages'];
    model?: string;
    system?: string;
  }): Promise<number>;

  /**
   * Execute one assistant turn. Single-turn wire adapter (D-01) — no loops,
   * no cap enforcement, no tool execution. Phase 24's engine loops over this
   * method while accumulating `messages` and enforcing `AUDIT_MAX_TOOL_CALLS`.
   *
   * Throws `LLMProviderError` with the appropriate variant on provider failure.
   */
  runAudit(opts: RunAuditOpts): Promise<RunAuditResult>;

  /**
   * List the priced models this provider knows about — synchronous, offline,
   * no network I/O. Derived from `Object.keys(PRICING[provider])`.
   *
   * Phase 27 D-04 revision: PRICING is the cost lookup; live `models.list()`
   * from each provider is the catalog. This synchronous `listModels()` retains
   * its original semantics (PRICING-derived, offline) and continues to power
   * the offline PRICING-fallback path inside `model-catalog.ts` (D-02) and the
   * `/settings/llm` PricingTable. The new async catalog surface is
   * `getModels(provider, keyId, credential): Promise<ListingsResult>` exposed from
   * `./index.js` — that is what the universe-settings model dropdown consumes.
   *
   * `pricing(model)` returning `undefined` is now a documented expected branch
   * (D-05 unpriced-but-selectable case) — see `ModelListingWithCoverage.hasPricing`.
   * It is NOT a contract violation; the live catalog may contain models PRICING
   * does not yet have rates for (new provider releases between PRICING bumps).
   */
  listModels(): ModelListing[];

  /**
   * Look up pricing for a single model id. Returns `undefined` if the model
   * is not in `PRICING`. Synchronous, no network I/O.
   *
   * Phase 24's pre-run cost-range UI calls this for the selected model;
   * `undefined` should map to a user-visible "unknown model" banner rather
   * than a fallback price.
   */
  pricing(model: string): ModelListing | undefined;
}

// ---------------------------------------------------------------------------
// Re-export of the suggestion stub
// ---------------------------------------------------------------------------

/**
 * Re-export for callers that import everything from `./interface.js`. The
 * canonical home of `AuditSuggestion` is `../../types/audit-suggestion.js`
 * (D-02); this re-export saves Phase 24 / Phase 25 a second import path.
 */
export type { AuditSuggestion };
