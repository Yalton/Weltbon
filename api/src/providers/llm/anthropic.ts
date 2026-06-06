/**
 * Phase 23 LLM provider-abstraction — concrete `AnthropicProvider`.
 *
 * Implements `LLMProvider` against `@anthropic-ai/sdk@^0.97.x` per PROVIDER-02.
 *
 * Design notes (all cross-referenced to project documentation):
 *
 *   - Default model is `claude-haiku-4-5` (RESEARCH §"Anthropic Cache Threshold").
 *
 *   - `validate(plaintext)` uses `client.messages.countTokens()` as a free,
 *     zero-billed auth ping (RESEARCH Pattern 2; [CITED: platform.claude.com
 *     /docs/en/build-with-claude/token-counting — "Token counting is free
 *     to use but subject to requests per minute rate limits"]).
 *
 *   - `estimate(opts)` likewise uses `client.messages.countTokens()` —
 *     zero-billed per PROVIDER-07.
 *
 *   - `runAudit(opts)` is a single-turn wire adapter (D-01). It issues ONE
 *     `client.messages.create()` call and returns one assistant turn — no
 *     loops, no tool-result handling, no cap enforcement. The multi-turn
 *     orchestration belongs to Phase 24's audit engine.
 *
 *   - Prompt caching: when an explicit `system` message is present in
 *     `opts.messages[0]` AND the pre-call `estimate` is ≥
 *     `MIN_CACHEABLE_TOKENS` (4096), the system block is extracted into the
 *     dedicated `system` parameter with `cache_control: { type: 'ephemeral' }`
 *     (RESEARCH Pattern 3, Pitfall #3). Below the threshold Anthropic
 *     silently ignores `cache_control` — the gate prevents wasted cache
 *     breakpoint budget.
 *
 *   - `stop_reason === 'refusal'` is checked POST-CALL on the HTTP-200
 *     response body (Pitfall #1). Refusals are NOT thrown SDK exceptions;
 *     they arrive as successful 200 responses. The check happens BEFORE
 *     content extraction so empty `toolUse` arrays from refusals never
 *     reach callers as silent successes.
 *
 *   - The class is stateless (Pitfall #6, threat T-23-03-04). It holds no
 *     instance fields. Every method constructs a local `new Anthropic({
 *     apiKey })` from the per-call argument; concurrent requests with
 *     different keys can never corrupt each other.
 *
 *   - Error mapping (`mapAnthropicError`) covers every Anthropic SDK
 *     subclass listed in RESEARCH §"SDK Error Taxonomy → 7 LLMError
 *     Variants" — 11 subclasses + APIError `.status` branches (402, 404,
 *     422, 529) — with a defensive `UnknownProviderError` fallback. Per
 *     threat T-23-03-01, the mapper NEVER includes the SDK's raw
 *     `err.message`, `err.body`, or `err.headers` in the normalized
 *     `LLMProviderError.message`; only deterministic operator-friendly
 *     strings (Phase 22 T-22-02-01 trust-boundary discipline).
 *
 *   - Note on `APIStatusError` (RESEARCH Anthropic error table): the
 *     SDK at version 0.97.x exports `APIError` (parent class with
 *     `readonly status`) but does NOT export a separate `APIStatusError`
 *     class. The error mapper therefore checks `err instanceof
 *     Anthropic.APIError` and branches on `err.status`. The plan called
 *     this `APIStatusError`; the semantic intent (branch on HTTP status
 *     for codes that have no dedicated subclass — 402, 404, 422, 529) is
 *     preserved unchanged.
 *
 *   - Cost computation: `computeAnthropicCost` follows RESEARCH Pattern
 *     7 — four-term sum (regular input + cache write + cache read +
 *     output), each (tokens × usdPer1M) / 1_000_000. `cache_creation_input_tokens`
 *     and `cache_read_input_tokens` can be `null` in the SDK response;
 *     they are coalesced to 0 before multiplication.
 *
 *   - Unknown-model guard: `runAudit` throws
 *     `LLMProviderError(ModelNotAvailable)` when `PRICING.anthropic[model]`
 *     is undefined (threat T-23-03-05). Without this guard a typo'd
 *     model name would silently produce `NaN` `costUsd` and corrupt
 *     downstream audit-run rollups.
 *
 * Requirements satisfied:
 *   - PROVIDER-01 (partial — Anthropic side of factory)
 *   - PROVIDER-02 (claude-haiku-4-5 default + cache_control gating)
 *   - PROVIDER-05 (Anthropic side of 7 LLMError variants)
 *   - PROVIDER-07 (zero-billed estimate via countTokens)
 *
 * Threats mitigated:
 *   - T-23-03-01 (Info Disclosure — no raw err.* in LLMProviderError.message)
 *   - T-23-03-02 (Tampering — cache_control silently no-ops below 4096)
 *   - T-23-03-03 (Spoofing — refusal stop_reason masquerading as success)
 *   - T-23-03-04 (DoS — stateless class; no shared connection state)
 *   - T-23-03-05 (Spoofing — unknown model → NaN cost)
 */

import Anthropic from '@anthropic-ai/sdk';
import type {
  MessageParam,
  MessageCreateParams,
  Tool,
  ToolUseBlock,
  TextBlock,
  Usage,
} from '@anthropic-ai/sdk/resources/messages';

import {
  LLMError,
  LLMProviderError,
  MIN_CACHEABLE_TOKENS,
  type LLMProvider,
  type ModelListing,
  type NormalizedUsage,
  type RunAuditOpts,
  type RunAuditResult,
} from './interface.js';
import { PRICING, type AnthropicModelPricing } from './pricing.js';

// ---------------------------------------------------------------------------
// Module-scope defaults
// ---------------------------------------------------------------------------

/**
 * Default Anthropic model when callers omit `opts.model`. Module scope (not
 * a class field) keeps the class stateless per Pitfall #6 / T-23-03-04.
 */
const defaultModel = 'claude-haiku-4-5-20251001';

// ---------------------------------------------------------------------------
// Engine-shape → Anthropic-shape message adapter
// ---------------------------------------------------------------------------

/**
 * The audit engine builds messages in an OpenAI-flavored abstract shape:
 *   - `{ role: 'assistant', content: JSON.stringify(toolUse[]) }` for tool-use turns
 *   - `{ role: 'tool',     content: JSON.stringify({ tool_call_id, content }) }` per result
 *   - `{ role: 'user'|'assistant', content: string }` for plain text turns
 *
 * Anthropic's `messages.create` rejects `role: 'tool'` outright and requires
 * tool_use / tool_result as structured CONTENT BLOCKS inside `assistant` /
 * `user` messages respectively. Multiple tool results in a single assistant
 * turn must coalesce into ONE `user` message containing multiple
 * `tool_result` blocks (Anthropic tool-use contract).
 *
 * This adapter is the translation boundary the Phase 23 provider abstraction
 * promised but never delivered — without it, every multi-turn Anthropic
 * audit fails with HTTP 400 `Unexpected role "tool"`.
 */
type EngineMsg = { role: 'system' | 'user' | 'assistant' | 'tool'; content: string };

function toAnthropicMessages(msgs: EngineMsg[]): MessageParam[] {
  const out: MessageParam[] = [];
  let pendingToolResults: Array<{
    type: 'tool_result';
    tool_use_id: string;
    content: string;
  }> = [];

  const flushPendingToolResults = (): void => {
    if (pendingToolResults.length === 0) return;
    out.push({ role: 'user', content: pendingToolResults });
    pendingToolResults = [];
  };

  for (const m of msgs) {
    if (m.role === 'system') {
      // System messages are handled separately by the caller (extracted into
      // the top-level `system` param). Skip here so we don't double-emit.
      continue;
    }

    if (m.role === 'tool') {
      // Engine envelope: { tool_call_id, content } — both fields stringified.
      let envelope: { tool_call_id?: string; content?: string };
      try {
        envelope = JSON.parse(m.content) as typeof envelope;
      } catch {
        // Malformed tool message — preserve as a text user message so the
        // provider doesn't silently lose data; Anthropic will surface a
        // useful error if the content is genuinely invalid.
        flushPendingToolResults();
        out.push({ role: 'user', content: m.content });
        continue;
      }
      pendingToolResults.push({
        type: 'tool_result',
        tool_use_id: envelope.tool_call_id ?? '',
        content: envelope.content ?? '',
      });
      continue;
    }

    // role: 'user' | 'assistant'
    flushPendingToolResults();

    if (m.role === 'assistant') {
      // Detect engine's tool-use serialization (JSON array of {id,name,input}).
      let toolUseBlocks: Array<{
        type: 'tool_use';
        id: string;
        name: string;
        input: Record<string, unknown>;
      }> | null = null;
      try {
        const parsed = JSON.parse(m.content);
        if (
          Array.isArray(parsed) &&
          parsed.length > 0 &&
          typeof parsed[0] === 'object' &&
          parsed[0] !== null &&
          'name' in parsed[0] &&
          'id' in parsed[0]
        ) {
          toolUseBlocks = (parsed as Array<{
            id: string;
            name: string;
            input: Record<string, unknown>;
          }>).map((tu) => ({
            type: 'tool_use',
            id: tu.id,
            name: tu.name,
            input: tu.input,
          }));
        }
      } catch {
        /* plain text content — fall through */
      }
      if (toolUseBlocks) {
        out.push({ role: 'assistant', content: toolUseBlocks });
      } else {
        out.push({ role: 'assistant', content: m.content });
      }
      continue;
    }

    // role: 'user' — plain text
    out.push({ role: 'user', content: m.content });
  }

  flushPendingToolResults();
  return out;
}

/**
 * Maximum response token budget passed as `max_tokens` to
 * `client.messages.create` in `runAudit`.
 *
 * NOTE (IN-01 disambiguation — Phase 23 gap-closure plan 23-08): this
 * constant is numerically equal to `MIN_CACHEABLE_TOKENS` (imported from
 * `./interface.ts` and also 4096), but the two values have completely
 * unrelated semantics:
 *
 *   - `ANTHROPIC_MAX_TOKENS` (this constant): caps the number of completion
 *     tokens the Anthropic messages.create API will return in a single turn.
 *     It is a *response output limit* passed in the API request body.
 *
 *   - `MIN_CACHEABLE_TOKENS` (interface.ts): the minimum *input prefix* size
 *     required for Anthropic's prompt cache to honor a `cache_control`
 *     breakpoint. It is a *cache eligibility threshold* on the prompt side.
 *
 * Using the same numeric literal 4096 for both roles was the source of the
 * IN-01 confusion flagged in 23-REVIEW. Promoting this side to a named
 * constant eliminates the ambiguity at a glance.
 */
const ANTHROPIC_MAX_TOKENS = 4096;

// ---------------------------------------------------------------------------
// Error mapping (PROVIDER-05 — Anthropic side)
// ---------------------------------------------------------------------------

/**
 * Translate an Anthropic SDK exception to a normalized `LLMProviderError`.
 *
 * IMPORTANT (T-23-03-01): the returned `message` is a deterministic
 * operator-friendly string. It NEVER includes `err.message`, `err.body`,
 * `err.headers`, or any other raw field from the SDK exception. Raw SDK
 * messages can echo back the prefix of the API key (`sk-ant-...`) or
 * internal request-IDs that constitute a trust-boundary violation when
 * surfaced to the HTTP response body. This mirrors Phase 22's discipline
 * for `validateAtProvider` (T-22-02-01).
 *
 * Mapping coverage per RESEARCH §"SDK Error Taxonomy → 7 LLMError Variants":
 *
 *   AuthenticationError (401)         → InvalidApiKey
 *   PermissionDeniedError (403)       → InvalidApiKey
 *   RateLimitError (429)              → RateLimited
 *   APIConnectionTimeoutError         → NetworkError
 *   APIConnectionError                → NetworkError
 *   InternalServerError (500+)        → NetworkError
 *   APIError.status === 402           → InsufficientCredits  (no dedicated subclass; 0.97.x has no APIStatusError)
 *   APIError.status === 529           → NetworkError         (Anthropic overloaded_error)
 *   APIError.status === 404 / 422     → ModelNotAvailable    (NotFoundError + UnprocessableEntityError also match this branch via instanceof APIError)
 *   BadRequestError (400, fallthrough) → UnknownProviderError
 *   <anything else>                   → UnknownProviderError (defensive fallback)
 */
function mapAnthropicError(err: unknown): LLMProviderError {
  if (err instanceof Anthropic.AuthenticationError) {
    return new LLMProviderError(LLMError.InvalidApiKey, 'Anthropic rejected the API key');
  }
  if (err instanceof Anthropic.PermissionDeniedError) {
    return new LLMProviderError(
      LLMError.InvalidApiKey,
      'Anthropic API key lacks required permissions',
    );
  }
  if (err instanceof Anthropic.RateLimitError) {
    return new LLMProviderError(LLMError.RateLimited, 'Anthropic rate limit exceeded');
  }
  if (err instanceof Anthropic.APIConnectionTimeoutError) {
    return new LLMProviderError(
      LLMError.NetworkError,
      'Anthropic request timed out — try again',
    );
  }
  if (err instanceof Anthropic.APIConnectionError) {
    return new LLMProviderError(
      LLMError.NetworkError,
      'Anthropic network error — try again in a moment',
    );
  }
  if (err instanceof Anthropic.InternalServerError) {
    return new LLMProviderError(
      LLMError.NetworkError,
      'Anthropic server error — try again in a moment',
    );
  }
  // APIError is the parent of every HTTP-status subclass in 0.97.x; branch
  // on `.status` for codes without dedicated subclasses we want to map
  // distinctly (402 InsufficientCredits, 529 overloaded, 404/422 model error).
  if (err instanceof Anthropic.APIError) {
    if (err.status === 402) {
      return new LLMProviderError(
        LLMError.InsufficientCredits,
        'Anthropic account is out of credits',
      );
    }
    if (err.status === 529) {
      return new LLMProviderError(
        LLMError.NetworkError,
        'Anthropic overloaded — try again in a moment',
      );
    }
    if (err.status === 404 || err.status === 422) {
      return new LLMProviderError(
        LLMError.ModelNotAvailable,
        'Anthropic model not available',
      );
    }
    // Falls through to BadRequestError / generic APIError handling below.
  }
  if (err instanceof Anthropic.BadRequestError) {
    // DIAGNOSTIC SURFACE — KEEP. T-24-04-09 forbids persisting raw provider
    // text to the DB (and the LLMProviderError carrier deliberately swallows
    // it), but operators still need it to diagnose 400s. status + message
    // only; never request bodies, headers, or API key material. The
    // wrapper message below references this exact line. Without it, the
    // Phase 24 message-shape adapter defect (engine role:'tool' rejected
    // by Anthropic) would have remained unfindable on 2026-05-26 — see
    // project documentation.
    console.error(
      '[anthropic] BadRequestError:',
      err.status,
      err.message,
    );
    return new LLMProviderError(
      LLMError.UnknownProviderError,
      'Unexpected Anthropic bad-request — see server log',
    );
  }
  // DIAGNOSTIC SURFACE — KEEP. Defensive fallback for any non-SDK
  // exception or future SDK subclass. Class name + message only; no
  // request bodies, headers, or key material. Same rationale as the
  // BadRequestError branch above.
  console.error(
    '[anthropic] unmapped error:',
    (err instanceof Error ? `${err.constructor.name}: ${err.message}` : String(err)),
  );
  return new LLMProviderError(LLMError.UnknownProviderError, 'Unknown Anthropic error');
}

// ---------------------------------------------------------------------------
// Cost helper (RESEARCH Pattern 7)
// ---------------------------------------------------------------------------

/**
 * Compute USD cost for a single `runAudit` turn from the SDK's `Usage` shape
 * and a `PRICING.anthropic[model]` pricing row.
 *
 * Four-term sum:
 *   regularInput + cacheWrite + cacheRead + output
 *
 * `cache_creation_input_tokens` and `cache_read_input_tokens` are `number | null`
 * in the SDK response; they are coalesced to `0` before multiplication so the
 * formula always returns a finite number (avoids `null * pricing = NaN`).
 *
 * Per the Anthropic billing docs and `NormalizedUsage` JSDoc on
 * `./interface.ts`, regular `input_tokens` are MUTUALLY EXCLUSIVE of the cache
 * fields — cached reads do NOT also count toward `input_tokens`. Phase 24's
 * cost rollup must NOT re-sum across the providers' normalized shape; this
 * function returns the correct single-turn total.
 */
function computeAnthropicCost(usage: Usage, pricing: AnthropicModelPricing): number {
  const cacheCreate = usage.cache_creation_input_tokens ?? 0;
  const cacheRead = usage.cache_read_input_tokens ?? 0;
  const regularInput = (usage.input_tokens * pricing.inputUsdPer1M) / 1_000_000;
  const cacheWrite = (cacheCreate * pricing.cacheWriteUsdPer1M) / 1_000_000;
  const cacheReadCost = (cacheRead * pricing.cachedInputUsdPer1M) / 1_000_000;
  const output = (usage.output_tokens * pricing.outputUsdPer1M) / 1_000_000;
  return regularInput + cacheWrite + cacheReadCost + output;
}

// ---------------------------------------------------------------------------
// Usage normalization (interface contract — camelCase, non-null cache fields)
// ---------------------------------------------------------------------------

/**
 * Translate the SDK's snake_case `Usage` to the camelCase `NormalizedUsage`
 * shape Phase 24's engine consumes. Nullable cache fields coalesce to 0 so
 * the engine can sum across turns without per-call null-handling.
 */
function normalizeUsage(usage: Usage): NormalizedUsage {
  return {
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    cacheCreationInputTokens: usage.cache_creation_input_tokens ?? 0,
    cacheReadInputTokens: usage.cache_read_input_tokens ?? 0,
  };
}

// ---------------------------------------------------------------------------
// AnthropicProvider
// ---------------------------------------------------------------------------

/**
 * Concrete provider for Anthropic. Stateless (no instance fields) — every
 * method constructs a fresh `new Anthropic({ apiKey })` from the per-call
 * key. This is THE invariant that makes the factory's lazy-singleton cache
 * (`./index.ts`) safe under concurrent multi-user load (T-23-03-04 / Pitfall #6).
 */
export class AnthropicProvider implements LLMProvider {
  /**
   * Verify the plaintext key with one zero-billed `messages.countTokens` call.
   * Throws `LLMProviderError` on any SDK exception (variant per
   * `mapAnthropicError`). Returns `void` on success.
   */
  async validate(plaintext: string): Promise<void> {
    const client = new Anthropic({ apiKey: plaintext });
    try {
      await client.messages.countTokens({
        model: defaultModel,
        messages: [{ role: 'user', content: 'hi' }],
      });
    } catch (err) {
      throw mapAnthropicError(err);
    }
  }

  /**
   * Pre-call token estimate via the SDK's free `messages.countTokens` endpoint.
   * Returns the integer `input_tokens` count from the SDK response.
   *
   * System-extraction (T-23-07-01 / T-23-07-02 defense-in-depth):
   *   - If `opts.system` is provided, it is forwarded to `countTokens` as the
   *     top-level `system` parameter so the count INCLUDES the system text.
   *   - As a defensive measure, any leading role:'system' message in
   *     `opts.messages` is also stripped before the SDK call — this prevents
   *     SDK 400s even if a caller incorrectly passes a system message inside
   *     the messages array. When both are provided, `opts.system` takes
   *     precedence (T-23-07-02: prefer opts.system, strip the inline system).
   * The cast `as MessageParam[]` that was previously here is removed: after
   * stripping role:'system', the remaining messages carry only roles in the
   * MessageParam union ('user' | 'assistant' | 'tool'), so no cast is needed.
   */
  async estimate(opts: {
    apiKey: string;
    messages: RunAuditOpts['messages'];
    model?: string;
    system?: string;
  }): Promise<number> {
    const client = new Anthropic({ apiKey: opts.apiKey });

    // Strip any leading role:'system' entry from opts.messages so the messages[]
    // array passed to countTokens never contains system-role entries.
    const firstMsg = opts.messages[0];
    const hasLeadingSystem = firstMsg?.role === 'system';
    // Build a properly-typed MessageParam[] without casting — roles 'user',
    // 'assistant', and 'tool' are all assignable to MessageParam; we simply
    // exclude the 'system' role via the type guard in the filter predicate.
    const nonSystemMessages = (hasLeadingSystem ? opts.messages.slice(1) : opts.messages)
      .filter((m): m is Exclude<typeof m, { role: 'system' }> => m.role !== 'system');
    const conversationMessages: MessageParam[] = nonSystemMessages.map((m) => ({
      role: m.role as MessageParam['role'],
      content: m.content,
    }));

    // Prefer opts.system when provided; fall back to the extracted leading-
    // system content; undefined when neither is present.
    const effectiveSystem: string | undefined =
      opts.system ?? (hasLeadingSystem ? firstMsg!.content : undefined);

    try {
      const res = await client.messages.countTokens({
        model: opts.model ?? defaultModel,
        messages: conversationMessages,
        ...(effectiveSystem !== undefined ? { system: effectiveSystem } : {}),
      });
      return res.input_tokens;
    } catch (err) {
      throw mapAnthropicError(err);
    }
  }

  /**
   * Single-turn wire adapter (D-01). One `messages.create` call in; one
   * assistant turn out as `{ text, toolUse, usage, costUsd }`.
   *
   * Cache gating (RESEARCH Pattern 3 / Pitfall #3): when `opts.messages[0]`
   * is a `system` message AND the pre-call estimate is ≥
   * `MIN_CACHEABLE_TOKENS`, the system message is extracted into the
   * dedicated `system` parameter with `cache_control: { type: 'ephemeral' }`.
   * Otherwise the messages array is passed through unchanged with no
   * `system` parameter (the wire adapter stays pure — engine controls
   * system content per Phase 24's design).
   *
   * Post-call refusal check (Pitfall #1): `response.stop_reason === 'refusal'`
   * throws `LLMProviderError(ContentBlockedBySafetyFilter)` BEFORE content
   * extraction. Refusals are HTTP-200 success responses, not thrown SDK
   * exceptions — this is the ONLY place a `stop_reason` can produce an
   * exception in this method.
   */
  async runAudit(opts: RunAuditOpts): Promise<RunAuditResult> {
    const model = opts.model ?? defaultModel;
    const pricing = (PRICING.anthropic as Record<string, AnthropicModelPricing>)[model];
    if (!pricing) {
      // T-23-03-05: unknown-model guard. Without this, costUsd would be NaN
      // and propagate to Phase 24's audit_runs.cost_usd.
      throw new LLMProviderError(
        LLMError.ModelNotAvailable,
        `Anthropic model not available: ${model}`,
      );
    }

    // Wire-adapter discipline (D-01): extract system BEFORE calling estimate so
    // both the token count and the messages.create call receive the correct shapes.
    // The engine drives system content; we only relocate `messages[0]` into the
    // dedicated `system` parameter when its role IS 'system'; otherwise we pass
    // messages unchanged with no system field.
    const first = opts.messages[0];
    const hasLeadingSystem = first?.role === 'system';

    type SystemBlock = { type: 'text'; text: string; cache_control?: { type: 'ephemeral' } };
    let conversationMessages: RunAuditOpts['messages'];
    let extractedSystemText: string | undefined;

    if (hasLeadingSystem) {
      extractedSystemText = first.content;
      conversationMessages = opts.messages.slice(1);
    } else {
      extractedSystemText = undefined;
      conversationMessages = opts.messages;
    }

    // Translate engine-shape → Anthropic-shape ONCE, then reuse for both the
    // countTokens call (cache eligibility) AND the messages.create call. The
    // engine emits `role: 'tool'` and JSON-stringified tool_use blocks; both
    // Anthropic endpoints reject that shape with HTTP 400. See
    // `toAnthropicMessages` above for the contract.
    const anthropicMessages = toAnthropicMessages(conversationMessages);

    // Determine cache eligibility based on the full prompt token count
    // (including system text). countTokens is free (no billing). System text
    // is passed top-level so the count includes its contribution.
    // Pitfall #3: applying cache_control below the threshold is silently
    // no-op'd by Anthropic.
    let promptTokens: number;
    try {
      const countClient = new Anthropic({ apiKey: opts.apiKey });
      const countRes = await countClient.messages.countTokens({
        model,
        messages: anthropicMessages,
        ...(extractedSystemText !== undefined ? { system: extractedSystemText } : {}),
      });
      promptTokens = countRes.input_tokens;
    } catch (err) {
      throw mapAnthropicError(err);
    }
    const useCache = promptTokens >= MIN_CACHEABLE_TOKENS;

    // Build the systemParam for messages.create — cache_control applied only
    // when the cache-eligibility gate passes.
    let systemParam: SystemBlock[] | undefined;
    if (hasLeadingSystem && extractedSystemText !== undefined) {
      const block: SystemBlock = { type: 'text', text: extractedSystemText };
      if (useCache) {
        block.cache_control = { type: 'ephemeral' };
      }
      systemParam = [block];
    } else {
      systemParam = undefined;
    }

    const client = new Anthropic({ apiKey: opts.apiKey });
    let response;
    try {
      const createParams: MessageCreateParams = {
        model,
        max_tokens: ANTHROPIC_MAX_TOKENS,
        messages: anthropicMessages, // shape adapter ran once above; see toAnthropicMessages.
        ...(systemParam ? { system: systemParam } : {}),
        ...(opts.tools ? { tools: opts.tools as Tool[] } : {}),
      };
      response = await client.messages.create(createParams);
    } catch (err) {
      throw mapAnthropicError(err);
    }

    // Streaming responses are a different SDK return type. Phase 23 uses
    // non-streaming exclusively (D-01 single-turn). Narrow defensively in
    // case future code passes `stream: true` through.
    if (!('content' in response)) {
      throw new LLMProviderError(
        LLMError.UnknownProviderError,
        'Anthropic returned a streaming response — non-streaming expected',
      );
    }

    // Pitfall #1 / T-23-03-03: refusal arrives as HTTP-200 with a populated
    // body and stop_reason: 'refusal'. We MUST check it before extracting
    // content; otherwise a refusal would silently return an empty toolUse
    // array as a "successful" call.
    if (response.stop_reason === 'refusal') {
      throw new LLMProviderError(
        LLMError.ContentBlockedBySafetyFilter,
        'Anthropic refused to generate content',
      );
    }
    // T-23-08-01 / CR-02 truncation guard: stop_reason 'max_tokens' means the
    // response was cut off at ANTHROPIC_MAX_TOKENS. A truncated tool_use block
    // is incomplete JSON; extracting it as a "successful" audit result would
    // silently mask the gap (the exact spoofing failure mode SC-3 targets).
    // This guard MUST sit BEFORE content extraction so no partial toolUse
    // array ever reaches callers as a success.
    if (response.stop_reason === 'max_tokens') {
      throw new LLMProviderError(
        LLMError.UnknownProviderError,
        'Anthropic response truncated by max_tokens — output is incomplete',
      );
    }

    // Extract tool_use blocks and text blocks. The SDK's ContentBlock union
    // has many shapes (thinking, server tool use, web search, etc.); the
    // `b.type === ...` narrowing handles the two we care about for D-01
    // and ignores the rest.
    const toolUse = response.content
      .filter((b): b is ToolUseBlock => b.type === 'tool_use')
      .map((b) => ({
        id: b.id,
        name: b.name,
        input: b.input as Record<string, unknown>,
      }));
    const text = response.content
      .filter((b): b is TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('');

    const costUsd = computeAnthropicCost(response.usage, pricing);

    return {
      text,
      toolUse,
      usage: normalizeUsage(response.usage),
      costUsd,
    };
  }

  /**
   * Phase 27: live model IDs from the Anthropic API.
   * Async, network I/O, constructs a fresh client per call (Pitfall #6).
   * Returns a flat array of raw model IDs; no PRICING merge, no filtering.
   * Throws LLMProviderError on failure (caller falls back per D-02).
   */
  async liveListModels(apiKey: string): Promise<string[]> {
    const client = new Anthropic({ apiKey });
    const ids: string[] = [];
    try {
      for await (const m of client.models.list({ limit: 100 })) {
        ids.push(m.id);
      }
    } catch (err) {
      throw mapAnthropicError(err);
    }
    return ids;
  }

  /**
   * Synchronous offline lookup of every Anthropic model in `PRICING.anthropic`.
   * Phase 27 D-04 revised: this is a fallback primitive — the live catalog
   * is `liveListModels()`. Adding/removing a model in `pricing.ts` is the
   * ONLY way to change what this fallback returns.
   */
  listModels(): ModelListing[] {
    return Object.keys(PRICING.anthropic).map((id) => {
      const row = PRICING.anthropic[id as keyof typeof PRICING.anthropic];
      return {
        id,
        inputUsdPer1M: row.inputUsdPer1M,
        outputUsdPer1M: row.outputUsdPer1M,
        cachedInputUsdPer1M: row.cachedInputUsdPer1M,
        cacheWriteUsdPer1M: row.cacheWriteUsdPer1M,
      };
    });
  }

  /**
   * Direct pricing lookup. Returns `undefined` for unknown models so the UI
   * can render an "unknown model" banner rather than guessing a price (D-04).
   */
  pricing(model: string): ModelListing | undefined {
    const row = (PRICING.anthropic as Record<string, AnthropicModelPricing>)[model];
    if (!row) return undefined;
    return {
      id: model,
      inputUsdPer1M: row.inputUsdPer1M,
      outputUsdPer1M: row.outputUsdPer1M,
      cachedInputUsdPer1M: row.cachedInputUsdPer1M,
      cacheWriteUsdPer1M: row.cacheWriteUsdPer1M,
    };
  }
}
