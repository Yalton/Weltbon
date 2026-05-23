/**
 * Phase 23-05 — LLMProvider CONTRACT test (PROVIDER-04 + PROVIDER-01 closure).
 *
 * Goal
 * ----
 * Lock the PROVIDER-04 success criterion at test time: drive IDENTICAL input
 * fixtures through both `vi.mock`'d SDKs and assert both `AnthropicProvider`
 * and `OpenAIProvider` produce IDENTICAL `AuditSuggestion[]` arrays from the
 * same logical content. This is the "one render path on the engine side"
 * property Phase 24 relies on.
 *
 * Per project documentation D-01 + D-02:
 * the assertion is on the WIRE-SHAPE contract of `RunAuditResult`
 * (`{ text, toolUse, usage, costUsd }`) and the parsed `AuditSuggestion[]`
 * payload — NOT on identical audit SEMANTICS. The two adapters take different
 * routes (Anthropic parses `content[].type === 'tool_use'`; OpenAI parses
 * `chat.completions.parse` output and wraps it into a synthetic `toolUse[]`)
 * but BOTH must materialize the same shape from equivalent fixture content.
 *
 * Per RESEARCH §"Mock SDK Strategy for Contract Test" (lines 513-625):
 * we `vi.mock` the two SDK modules at the TypeScript module boundary. The
 * fixtures returned by the mocks reference a single SHARED_SUGGESTIONS
 * source-of-truth array, so we can assert that both providers extract
 * exactly that array — empty results or shape drift would fail loudly.
 *
 * Without this contract test, Phase 24's engine could subtly diverge per
 * provider without anyone noticing until a real audit run produces shape-
 * mismatched output. The test runs in the unit lane (no DB), in < 5 seconds.
 *
 * Mocking strategy (mirrors `llm-anthropic.test.ts` + `llm-openai.test.ts`):
 *   - `vi.mock('@anthropic-ai/sdk')` exposes a callable default whose
 *     `messages.create` returns a tool_use block carrying SHARED_SUGGESTIONS
 *     and whose `messages.countTokens` returns 0 (below MIN_CACHEABLE_TOKENS
 *     so no cache_control branch is exercised).
 *   - `vi.mock('openai')` exposes a callable default whose
 *     `chat.completions.parse` returns `message.parsed.suggestions` =
 *     SHARED_SUGGESTIONS, and whose `models.list` resolves to empty data.
 *   - `vi.mock('openai/helpers/zod')` passes through the schema + name as a
 *     plausible response_format object (the real Zod-vs-helper compatibility
 *     is locked separately in `llm-openai.test.ts` test #13).
 *   - All three mocks attach static-member error subclasses via Object.assign
 *     so production-code `err instanceof OpenAI.AuthenticationError` checks
 *     don't crash at module evaluation (the error branches aren't exercised
 *     in the success-path contract assertions, but the import-time presence
 *     of `OpenAI.APIError` etc. must remain truthy).
 *
 * Coverage
 * --------
 *   1. PROVIDER-01 — both providers conform to the 5-method LLMProvider
 *      interface (`validate`, `estimate`, `runAudit`, `listModels`, `pricing`).
 *   2. PROVIDER-04 — both providers extract IDENTICAL AuditSuggestion[] from
 *      identical fixture content (the eponymous contract assertion).
 *   3. Wire-shape parity — both providers return RunAuditResult with the same
 *      4-key shape (`text`, `toolUse`, `usage`, `costUsd`) and NormalizedUsage
 *      with the same 4-key shape (cache fields = 0 for OpenAI per the
 *      `NormalizedUsage` JSDoc in `interface.ts`).
 *   4. Tool-name convention — both providers materialize `toolUse[0].name ===
 *      'emit_findings'` (the wire-shape convention for Phase 24 engine).
 *   5. Positive-cost invariant — both providers compute `costUsd > 0` for the
 *      100-input / 50-output fixture.
 *   6. D-02 boundary — `AuditSuggestion` contains only the 4-or-5 provider-
 *      emitted fields; no engine-set fields (gap_key, source, model, runId,
 *      dismissalSnapshot) leak into Phase 23 outputs.
 *   7. validate() success path — both providers resolve when SDK ping
 *      resolves.
 *   8. listModels() shape — both providers return ≥ 2 listings with the
 *      required pricing fields.
 *
 * Requirements satisfied:
 *   - PROVIDER-04 (the contract test itself)
 *   - PROVIDER-01 closure (cross-provider conformance to LLMProvider surface)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AuditSuggestion } from '../src/types/audit-suggestion.js';

// CRITICAL — must be set BEFORE the *first* env() call in the process. config.ts
// caches `_env` on first call. This is defensive: neither anthropic.ts nor
// openai.ts touches the DB / config layer, but the import chain through
// ../src/providers/llm/index.js could grow this dependency in future plans.
vi.hoisted(() => {
  process.env.LLM_KEY_ENCRYPTION_KEY = '0'.repeat(64);
});

// ---------------------------------------------------------------------------
// SHARED FIXTURES — single source of truth driven through both mocked SDKs
// ---------------------------------------------------------------------------

/**
 * Shared input messages — identical content fed to BOTH providers. A simple
 * single-user-turn so neither provider's `system` branch (Anthropic cache
 * extraction, OpenAI passthrough) needs to differ.
 */
const SHARED_MESSAGES: Array<{ role: 'user'; content: string }> = [
  { role: 'user', content: 'Find gaps in this world.' },
];

/**
 * SHARED suggestion array — the canonical source of truth for the contract
 * assertion. Both mocked SDKs return THIS exact array (Anthropic via
 * tool_use[0].input.suggestions; OpenAI via choices[0].message.parsed.suggestions).
 *
 * The contract test asserts that BOTH providers, after their respective parse
 * paths, materialize an `AuditSuggestion[]` equal to this fixture (Threat
 * T-23-05-03 mitigation: a vacuous empty-array contract would fail because
 * this array has 2 distinct entries).
 *
 * D-02 boundary: only the 4-or-5 provider-emitted fields are present. No
 * engine fields (gap_key, source, model, runId, dismissalSnapshot) appear —
 * the AuditSuggestion shape check below (test #6) enforces this.
 */
const SHARED_SUGGESTIONS: AuditSuggestion[] = [
  {
    category: 'missing-link',
    // entryId intentionally omitted — exercises the optional field
    referencedEntryIds: ['entry-1', 'entry-2'],
    rationale: 'These two entries have no explicit connection.',
    evidence: 'Entry 1 mentions X; Entry 2 mentions Y.',
  },
  {
    category: 'underdeveloped',
    entryId: 'entry-3',
    referencedEntryIds: ['entry-3'],
    rationale: 'Entry has only a one-line summary.',
    evidence: 'Summary length: 12 characters.',
  },
];

// ---------------------------------------------------------------------------
// vi.mock — Anthropic SDK
// ---------------------------------------------------------------------------
//
// Pattern mirrors `llm-anthropic.test.ts`: vi.hoisted() builds instanceof-
// checkable error subclasses (so production code's `err instanceof
// Anthropic.AuthenticationError` doesn't crash even though we never throw
// these errors from the contract test's success-path fixtures); then
// vi.mock returns a callable default with Object.assign'd static members.
//
// Note on `messages.countTokens`: AnthropicProvider.runAudit calls
// `this.estimate()` (which delegates to countTokens) BEFORE `messages.create`
// to determine cache eligibility. We mock it to resolve with 0 input tokens
// so MIN_CACHEABLE_TOKENS (4096) gate stays closed and no cache_control
// branch fires — the contract test focuses on the parsed-output shape, not
// the cache pathway (which is locked in `llm-anthropic.test.ts` test #14/15).

const { AnthropicMockedErrors } = vi.hoisted(() => {
  class MockAnthropicError extends Error {}
  class MockAPIError extends MockAnthropicError {
    public readonly status: number | undefined;
    constructor(message: string, status?: number) {
      super(message);
      this.status = status;
    }
  }
  class MockAuthenticationError extends MockAPIError {}
  class MockPermissionDeniedError extends MockAPIError {}
  class MockBadRequestError extends MockAPIError {}
  class MockRateLimitError extends MockAPIError {}
  class MockInternalServerError extends MockAPIError {}
  class MockAPIConnectionError extends MockAnthropicError {}
  class MockAPIConnectionTimeoutError extends MockAPIConnectionError {}
  class MockNotFoundError extends MockAPIError {}
  class MockUnprocessableEntityError extends MockAPIError {}

  const AnthropicMockedErrors = {
    AnthropicError: MockAnthropicError,
    APIError: MockAPIError,
    AuthenticationError: MockAuthenticationError,
    PermissionDeniedError: MockPermissionDeniedError,
    BadRequestError: MockBadRequestError,
    RateLimitError: MockRateLimitError,
    InternalServerError: MockInternalServerError,
    APIConnectionError: MockAPIConnectionError,
    APIConnectionTimeoutError: MockAPIConnectionTimeoutError,
    NotFoundError: MockNotFoundError,
    UnprocessableEntityError: MockUnprocessableEntityError,
  };

  return { AnthropicMockedErrors };
});

vi.mock('@anthropic-ai/sdk', () => {
  // Mocked Anthropic happy-path response: the tool_use block carries
  // SHARED_SUGGESTIONS as its input.suggestions. Anthropic provider extracts
  // this directly into result.toolUse[0].input.suggestions.
  const happyResponse = {
    id: 'msg_mock',
    role: 'assistant' as const,
    content: [
      {
        type: 'tool_use' as const,
        id: 'tu_mock',
        name: 'emit_findings',
        input: { suggestions: SHARED_SUGGESTIONS },
      },
    ],
    stop_reason: 'tool_use',
    usage: {
      input_tokens: 100,
      output_tokens: 50,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
  };

  const AnthropicMock = vi.fn().mockImplementation(() => ({
    messages: {
      // create returns the canonical happy-path tool_use response
      create: vi.fn().mockResolvedValue(happyResponse),
      // countTokens returns 0 → below MIN_CACHEABLE_TOKENS (4096) → no
      // cache_control branch is exercised in the contract test
      countTokens: vi.fn().mockResolvedValue({ input_tokens: 0 }),
    },
  }));
  Object.assign(AnthropicMock, AnthropicMockedErrors);
  return { default: AnthropicMock };
});

// ---------------------------------------------------------------------------
// vi.mock — OpenAI SDK
// ---------------------------------------------------------------------------

const { OpenAIMockedErrors } = vi.hoisted(() => {
  class MockOpenAIError extends Error {}
  class MockAPIError extends MockOpenAIError {
    public readonly status: number | undefined;
    constructor(message: string, status?: number) {
      super(message);
      this.status = status;
    }
  }
  class MockAuthenticationError extends MockAPIError {}
  class MockPermissionDeniedError extends MockAPIError {}
  class MockBadRequestError extends MockAPIError {}
  class MockRateLimitError extends MockAPIError {}
  class MockInternalServerError extends MockAPIError {}
  class MockAPIConnectionError extends MockAPIError {}
  class MockNotFoundError extends MockAPIError {}
  class MockUnprocessableEntityError extends MockAPIError {}

  const OpenAIMockedErrors = {
    OpenAIError: MockOpenAIError,
    APIError: MockAPIError,
    AuthenticationError: MockAuthenticationError,
    PermissionDeniedError: MockPermissionDeniedError,
    BadRequestError: MockBadRequestError,
    RateLimitError: MockRateLimitError,
    InternalServerError: MockInternalServerError,
    APIConnectionError: MockAPIConnectionError,
    NotFoundError: MockNotFoundError,
    UnprocessableEntityError: MockUnprocessableEntityError,
  };

  return { OpenAIMockedErrors };
});

vi.mock('openai', () => {
  // Mocked OpenAI happy-path response: choices[0].message.parsed.suggestions
  // carries SHARED_SUGGESTIONS. OpenAI provider synthesizes a tool_use-shaped
  // wrapper around this so result.toolUse[0].input.suggestions matches the
  // Anthropic shape exactly (per Plan 23-04 step 9c).
  const happyResponse = {
    choices: [
      {
        message: {
          parsed: { suggestions: SHARED_SUGGESTIONS },
          refusal: null,
          content: '',
        },
        finish_reason: 'stop' as const,
      },
    ],
    usage: {
      prompt_tokens: 100,
      completion_tokens: 50,
    },
  };

  const OpenAIMock = vi.fn().mockImplementation(() => ({
    chat: {
      completions: {
        parse: vi.fn().mockResolvedValue(happyResponse),
      },
    },
    models: {
      list: vi.fn().mockResolvedValue({ data: [], object: 'list' }),
    },
  }));
  Object.assign(OpenAIMock, OpenAIMockedErrors);
  return { default: OpenAIMock };
});

// Pass-through helper mock — the real `zodResponseFormat` + Zod compat is
// locked separately in `llm-openai.test.ts` test #13 via vi.importActual.
// Here we just need the helper to return a plausible response_format object
// so `chat.completions.parse` is invoked with a non-throwing argument.
vi.mock('openai/helpers/zod', () => ({
  zodResponseFormat: vi.fn((schema, name) => ({
    type: 'json_schema',
    json_schema: { schema, name },
  })),
}));

// ---------------------------------------------------------------------------
// Cache reset — each it-body re-imports getProvider() so the lazy-singleton
// cache in `./index.ts` is repopulated against the same mocked SDK pair.
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Contract assertions
// ---------------------------------------------------------------------------

describe('LLMProvider contract (PROVIDER-04 + PROVIDER-01)', () => {
  // ---- 1. PROVIDER-01 conformance --------------------------------------

  it('both providers conform to the 5-method LLMProvider interface (PROVIDER-01)', async () => {
    const { getProvider } = await import('../src/providers/llm/index.js');
    for (const name of ['anthropic', 'openai'] as const) {
      const p = getProvider(name);
      expect(typeof p.validate).toBe('function');
      expect(typeof p.estimate).toBe('function');
      expect(typeof p.runAudit).toBe('function');
      expect(typeof p.listModels).toBe('function');
      expect(typeof p.pricing).toBe('function');
    }
  });

  // ---- 2. PROVIDER-04 — IDENTICAL AuditSuggestion[] extraction ----------

  it('both providers extract identical AuditSuggestion[] from identical fixtures (PROVIDER-04)', async () => {
    const { getProvider } = await import('../src/providers/llm/index.js');

    const anthropicResult = await getProvider('anthropic').runAudit({
      apiKey: 'a',
      messages: SHARED_MESSAGES,
      model: 'claude-haiku-4-5',
    });
    const openaiResult = await getProvider('openai').runAudit({
      apiKey: 'o',
      messages: SHARED_MESSAGES,
      model: 'gpt-5-mini',
    });

    // Both providers materialize the parsed suggestions under
    // toolUse[0].input.suggestions per Plans 23-03 / 23-04.
    const anthropicSuggestions =
      (anthropicResult.toolUse[0]?.input as { suggestions: AuditSuggestion[] } | undefined)
        ?.suggestions ?? [];
    const openaiSuggestions =
      (openaiResult.toolUse[0]?.input as { suggestions: AuditSuggestion[] } | undefined)
        ?.suggestions ?? [];

    // CONTRACT: the two parsed arrays are identical to each other AND to
    // the source-of-truth SHARED_SUGGESTIONS fixture. Threat T-23-05-01
    // tampering (one provider drifting) would fail loudly here.
    expect(anthropicSuggestions).toEqual(openaiSuggestions);
    expect(anthropicSuggestions).toEqual(SHARED_SUGGESTIONS);
    expect(openaiSuggestions).toEqual(SHARED_SUGGESTIONS);

    // Sanity-check non-vacuity — threat T-23-05-03 (empty array spoofing
    // would also pass toEqual([])). SHARED_SUGGESTIONS has 2 distinct
    // categories so a vacuous mock returning [] would fail here.
    expect(anthropicSuggestions).toHaveLength(2);
    expect(openaiSuggestions).toHaveLength(2);
  });

  // ---- 3. Wire-shape parity --------------------------------------------

  it('both providers return RunAuditResult with the same 4-key shape', async () => {
    const { getProvider } = await import('../src/providers/llm/index.js');

    const anthropicResult = await getProvider('anthropic').runAudit({
      apiKey: 'a',
      messages: SHARED_MESSAGES,
      model: 'claude-haiku-4-5',
    });
    const openaiResult = await getProvider('openai').runAudit({
      apiKey: 'o',
      messages: SHARED_MESSAGES,
      model: 'gpt-5-mini',
    });

    const expectedTopKeys = ['costUsd', 'text', 'toolUse', 'usage'];
    expect(Object.keys(anthropicResult).sort()).toEqual(expectedTopKeys);
    expect(Object.keys(openaiResult).sort()).toEqual(expectedTopKeys);

    const expectedUsageKeys = [
      'cacheCreationInputTokens',
      'cacheReadInputTokens',
      'inputTokens',
      'outputTokens',
    ];
    expect(Object.keys(anthropicResult.usage).sort()).toEqual(expectedUsageKeys);
    expect(Object.keys(openaiResult.usage).sort()).toEqual(expectedUsageKeys);

    // OpenAI's cache fields are 0 per Plan 23-04 normalizeUsage (no
    // OpenAI cache-write/read billing surface). Anthropic's fixture also
    // sets both cache fields to 0.
    expect(openaiResult.usage.cacheCreationInputTokens).toBe(0);
    expect(openaiResult.usage.cacheReadInputTokens).toBe(0);
    expect(anthropicResult.usage.cacheCreationInputTokens).toBe(0);
    expect(anthropicResult.usage.cacheReadInputTokens).toBe(0);
  });

  // ---- 4. Tool-name convention ----------------------------------------

  it("both providers materialize toolUse[0].name === 'emit_findings'", async () => {
    const { getProvider } = await import('../src/providers/llm/index.js');

    const anthropicResult = await getProvider('anthropic').runAudit({
      apiKey: 'a',
      messages: SHARED_MESSAGES,
      model: 'claude-haiku-4-5',
    });
    const openaiResult = await getProvider('openai').runAudit({
      apiKey: 'o',
      messages: SHARED_MESSAGES,
      model: 'gpt-5-mini',
    });

    expect(anthropicResult.toolUse[0]?.name).toBe('emit_findings');
    expect(openaiResult.toolUse[0]?.name).toBe('emit_findings');
  });

  // ---- 5. Positive-cost invariant -------------------------------------

  it('both providers compute non-zero positive costUsd for the success fixture', async () => {
    const { getProvider } = await import('../src/providers/llm/index.js');

    const anthropicResult = await getProvider('anthropic').runAudit({
      apiKey: 'a',
      messages: SHARED_MESSAGES,
      model: 'claude-haiku-4-5',
    });
    const openaiResult = await getProvider('openai').runAudit({
      apiKey: 'o',
      messages: SHARED_MESSAGES,
      model: 'gpt-5-mini',
    });

    // Exact per-provider values differ (different pricing tables); both
    // must be > 0 for a 100-input / 50-output call.
    expect(anthropicResult.costUsd).toBeGreaterThan(0);
    expect(openaiResult.costUsd).toBeGreaterThan(0);
    // Both must be finite — NaN would indicate the model-pricing lookup
    // missed (threat T-23-03-05 / T-23-04-05).
    expect(Number.isFinite(anthropicResult.costUsd)).toBe(true);
    expect(Number.isFinite(openaiResult.costUsd)).toBe(true);
  });

  // ---- 6. D-02 boundary — AuditSuggestion shape conforms ---------------

  it('AuditSuggestion shape contains only the D-02 provider-emitted fields (no engine field leak)', async () => {
    const { getProvider } = await import('../src/providers/llm/index.js');

    // Use the Anthropic result; the previous test already proves the OpenAI
    // result has the same content. The D-02 invariant is a per-suggestion
    // property — same for both providers.
    const result = await getProvider('anthropic').runAudit({
      apiKey: 'a',
      messages: SHARED_MESSAGES,
      model: 'claude-haiku-4-5',
    });
    const suggestions =
      (result.toolUse[0]?.input as { suggestions: AuditSuggestion[] } | undefined)
        ?.suggestions ?? [];
    expect(suggestions.length).toBeGreaterThan(0);

    // D-02: AuditSuggestion has exactly these 5 fields (entryId optional).
    // The allow-list is the canonical AuditSuggestion type in
    // ../src/types/audit-suggestion.ts. Any extra field on a parsed
    // suggestion would indicate that Phase 24 engine logic (gap_key,
    // source, model, runId, dismissalSnapshot per D-02 documentation) has
    // drifted into Phase 23 provider territory.
    const allowedFields = new Set([
      'category',
      'entryId',
      'referencedEntryIds',
      'rationale',
      'evidence',
    ]);

    for (const s of suggestions) {
      for (const key of Object.keys(s)) {
        expect(allowedFields.has(key)).toBe(true);
      }
      // Required fields per D-02:
      expect(typeof s.category).toBe('string');
      expect(Array.isArray(s.referencedEntryIds)).toBe(true);
      expect(typeof s.rationale).toBe('string');
      expect(typeof s.evidence).toBe('string');
    }
  });

  // ---- 7. validate() success path -------------------------------------

  it('validate() resolves for both providers when the SDK ping resolves', async () => {
    const { getProvider } = await import('../src/providers/llm/index.js');
    await expect(getProvider('anthropic').validate('any-key')).resolves.toBeUndefined();
    await expect(getProvider('openai').validate('any-key')).resolves.toBeUndefined();
  });

  // ---- 8. listModels() shape ------------------------------------------

  it('listModels() returns ≥ 2 entries per provider with correct pricing-field types', async () => {
    const { getProvider } = await import('../src/providers/llm/index.js');

    for (const name of ['anthropic', 'openai'] as const) {
      const models = getProvider(name).listModels();
      expect(models.length).toBeGreaterThanOrEqual(2);
      for (const model of models) {
        expect(typeof model.id).toBe('string');
        expect(model.id.length).toBeGreaterThan(0);
        expect(typeof model.inputUsdPer1M).toBe('number');
        expect(typeof model.outputUsdPer1M).toBe('number');
        expect(model.inputUsdPer1M).toBeGreaterThan(0);
        expect(model.outputUsdPer1M).toBeGreaterThan(0);
      }
    }
  });
});
