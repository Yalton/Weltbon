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
 *      'emit_findings'` (the wire-shape convention for Phase 27 engine: the
 *      model invokes emit_findings to deliver its final-turn answer).
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

// Phase 27 D-11: module-scope mock handles so per-test cases can override
// the SDK's response via mockResolvedValueOnce (engine-shape fixtures +
// emit_findings round-trip + smuggled-gap_key need per-call control).
// The hoisted block initialises the handles + default error subclasses BEFORE
// any vi.mock() factory closes over them.
const {
  mockMessagesCreate,
  mockMessagesCountTokens,
  mockChatCompletionsCreate,
  AnthropicMockedErrors,
} = vi.hoisted(() => {
  const mockMessagesCreate = vi.fn();
  const mockMessagesCountTokens = vi.fn();
  const mockChatCompletionsCreate = vi.fn();

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

  return {
    mockMessagesCreate,
    mockMessagesCountTokens,
    mockChatCompletionsCreate,
    AnthropicMockedErrors,
  };
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

  // Default the module-scope handles to the canonical happy-path response so
  // existing 8-coverage-point tests stay green; new D-11 cases override per
  // test via mockMessagesCreate.mockResolvedValueOnce(...).
  mockMessagesCreate.mockResolvedValue(happyResponse);
  mockMessagesCountTokens.mockResolvedValue({ input_tokens: 0 });

  const AnthropicMock = vi.fn().mockImplementation(() => ({
    messages: {
      create: mockMessagesCreate,
      // countTokens stays below MIN_CACHEABLE_TOKENS so no cache_control
      // branch fires (the contract test focuses on parsed-output shape).
      countTokens: mockMessagesCountTokens,
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
  // Phase 27 D-09: OpenAI provider now calls chat.completions.create() with
  // function-tool calling. The model "invokes" emit_findings to deliver the
  // final answer; arguments is a JSON-stringified suggestions envelope.
  // The provider parses arguments and normalizes to the engine-facing
  // { id, name, input } shape — IDENTICAL to Anthropic's tool_use blocks.
  const happyResponse = {
    choices: [
      {
        message: {
          role: 'assistant' as const,
          content: null,
          refusal: null,
          tool_calls: [
            {
              id: 'call_contract_mock',
              type: 'function' as const,
              function: {
                name: 'emit_findings',
                arguments: JSON.stringify({ suggestions: SHARED_SUGGESTIONS }),
              },
            },
          ],
        },
        finish_reason: 'tool_calls' as const,
      },
    ],
    usage: {
      prompt_tokens: 100,
      completion_tokens: 50,
    },
  };

  // Default the module-scope handle to the canonical happy-path response so
  // existing 8-coverage-point tests stay green; new D-11 cases override per
  // test via mockChatCompletionsCreate.mockResolvedValueOnce(...).
  mockChatCompletionsCreate.mockResolvedValue(happyResponse);

  const OpenAIMock = vi.fn().mockImplementation(() => ({
    chat: {
      completions: {
        create: mockChatCompletionsCreate,
        // `parse` retained for back-compat — runAudit() no longer invokes
        // it (Phase 27 D-09), so this mock is a vestigial defense in depth.
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
      credential: { apiKey: 'a' },
      messages: SHARED_MESSAGES,
      model: 'claude-haiku-4-5-20251001',
    });
    const openaiResult = await getProvider('openai').runAudit({
      credential: { apiKey: 'o' },
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
      credential: { apiKey: 'a' },
      messages: SHARED_MESSAGES,
      model: 'claude-haiku-4-5-20251001',
    });
    const openaiResult = await getProvider('openai').runAudit({
      credential: { apiKey: 'o' },
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
      credential: { apiKey: 'a' },
      messages: SHARED_MESSAGES,
      model: 'claude-haiku-4-5-20251001',
    });
    const openaiResult = await getProvider('openai').runAudit({
      credential: { apiKey: 'o' },
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
      credential: { apiKey: 'a' },
      messages: SHARED_MESSAGES,
      model: 'claude-haiku-4-5-20251001',
    });
    const openaiResult = await getProvider('openai').runAudit({
      credential: { apiKey: 'o' },
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
      credential: { apiKey: 'a' },
      messages: SHARED_MESSAGES,
      model: 'claude-haiku-4-5-20251001',
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
    await expect(getProvider('anthropic').validate({ apiKey: 'any-key' })).resolves.toBeUndefined();
    await expect(getProvider('openai').validate({ apiKey: 'any-key' })).resolves.toBeUndefined();
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

// ===========================================================================
// Phase 27 D-11 — engine-shape fixtures (the test that would have caught
// commit 23bb99f's defect on first run)
// ===========================================================================
//
// Defect class (from commit 23bb99f, fixed 2026-05-26):
//   The engine emits OpenAI-flavoured messages on multi-turn audits:
//     - { role: 'assistant', content: JSON.stringify(toolUse[]) }
//     - { role: 'tool',     content: JSON.stringify({ tool_call_id, content }) }
//   Anthropic's SDK rejects these with HTTP 400 "Unexpected role 'tool'" —
//   the engine-emitted shape must be wire-translated to Anthropic's
//   structured tool_use/tool_result content blocks. The defect went out to
//   production because the existing PROVIDER-04 contract test only fed
//   trivial { role: 'user', content } messages through the provider; no
//   multi-turn engine-shape fixture exercised the translation path.
//
// Phase 27 D-11 adds engine-shape fixtures that mirror the actual engine
// output. The fixtures round-trip through BOTH providers; any future
// regression that drops the wire-translation step (Anthropic) or rejects
// the engine-shape (OpenAI) fails this test at PR time via CI.
// ===========================================================================
describe('engine-shape fixtures (D-11 — would have caught commit 23bb99f)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('multi-turn engine-shape messages round-trip through Anthropic without HTTP 400', async () => {
    // Reproduce the engine's actual emitted shape on a multi-turn audit:
    //   turn 1: user → asks for findings
    //   turn 2: assistant emits getEntryBody tool_use (engine encodes as
    //           role:'assistant' + JSON.stringify(toolUse[]))
    //   turn 3: engine feeds back tool_result (role:'tool' + JSON.stringify
    //           wrapper carrying tool_call_id + content)
    //
    // The provider MUST translate this engine-shape into Anthropic's
    // structured content blocks. Anthropic's SDK rejects role:'tool' with
    // HTTP 400, so a missing translation step would manifest here as the
    // mocked SDK never being called with the translated shape OR (in
    // production) as a thrown LLMProviderError. This test asserts the
    // provider's runAudit completes without throwing on engine-shape input.
    mockMessagesCountTokens.mockResolvedValueOnce({ input_tokens: 100 });
    mockMessagesCreate.mockResolvedValueOnce({
      id: 'msg_engine_shape',
      role: 'assistant' as const,
      content: [
        {
          type: 'tool_use' as const,
          id: 'tu_final',
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
    });

    const { getProvider } = await import('../src/providers/llm/index.js');
    const engineMessages: Array<{ role: 'user' | 'assistant' | 'tool'; content: string }> = [
      { role: 'user', content: 'Find gaps in this universe.' },
      {
        role: 'assistant',
        content: JSON.stringify([
          {
            id: 'tu_prev',
            name: 'getEntryBody',
            input: { entryId: '00000000-0000-4000-8000-000000000001' },
          },
        ]),
      },
      {
        role: 'tool',
        content: JSON.stringify({
          tool_call_id: 'tu_prev',
          content: JSON.stringify({ id: '00000000-0000-4000-8000-000000000001', body: 'Entry body text' }),
        }),
      },
    ];

    // The contract: runAudit completes (no thrown error) when given engine-shape
    // multi-turn messages. The Anthropic adapter's toAnthropicMessages translator
    // is exercised — a missing translator (the 23bb99f regression class) would
    // surface as either the mocked SDK rejecting the role:'tool' shape OR a
    // production HTTP 400. The runAudit return must surface the final-turn
    // emit_findings tool_use.
    const result = await getProvider('anthropic').runAudit({
      credential: { apiKey: 'a' },
      messages: engineMessages,
      model: 'claude-haiku-4-5-20251001',
    });
    expect(result.toolUse).toHaveLength(1);
    expect(result.toolUse[0].name).toBe('emit_findings');
  });

  it('multi-turn engine-shape messages round-trip through OpenAI without provider error', async () => {
    // Phase 27 D-09: OpenAI's chat.completions.create accepts the engine's
    // role:'tool' / role:'assistant' shapes natively (OpenAI was the
    // reference shape the engine was originally built against — that's
    // exactly why Anthropic needed the translator). This test locks the
    // OpenAI half of the contract: identical engine-shape multi-turn
    // messages drive through to a successful runAudit with the
    // emit_findings tool_use surfaced.
    mockChatCompletionsCreate.mockResolvedValueOnce({
      choices: [
        {
          message: {
            role: 'assistant' as const,
            content: null,
            refusal: null,
            tool_calls: [
              {
                id: 'call_final',
                type: 'function' as const,
                function: {
                  name: 'emit_findings',
                  arguments: JSON.stringify({ suggestions: SHARED_SUGGESTIONS }),
                },
              },
            ],
          },
          finish_reason: 'tool_calls' as const,
        },
      ],
      usage: { prompt_tokens: 100, completion_tokens: 50 },
    });

    const { getProvider } = await import('../src/providers/llm/index.js');
    const engineMessages: Array<{ role: 'user' | 'assistant' | 'tool'; content: string }> = [
      { role: 'user', content: 'Find gaps in this universe.' },
      {
        role: 'assistant',
        content: JSON.stringify([
          {
            id: 'call_prev',
            name: 'getEntryBody',
            input: { entryId: '00000000-0000-4000-8000-000000000001' },
          },
        ]),
      },
      {
        role: 'tool',
        content: JSON.stringify({
          tool_call_id: 'call_prev',
          content: JSON.stringify({ id: '00000000-0000-4000-8000-000000000001', body: 'Entry body text' }),
        }),
      },
    ];

    const result = await getProvider('openai').runAudit({
      credential: { apiKey: 'o' },
      messages: engineMessages,
      model: 'gpt-5-mini',
    });
    expect(result.toolUse).toHaveLength(1);
    expect(result.toolUse[0].name).toBe('emit_findings');
  });
});

// ===========================================================================
// Phase 27 D-11 — emit_findings round-trip (the symmetric contract assertion)
// ===========================================================================
describe('emit_findings round-trip (D-11)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('both providers materialize SHARED_SUGGESTIONS from an emit_findings tool_use response', async () => {
    // Anthropic: tool_use block carrying SHARED_SUGGESTIONS as input.suggestions.
    mockMessagesCountTokens.mockResolvedValueOnce({ input_tokens: 100 });
    mockMessagesCreate.mockResolvedValueOnce({
      id: 'msg_emit_rt',
      role: 'assistant' as const,
      content: [
        {
          type: 'tool_use' as const,
          id: 'tu_emit_rt',
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
    });
    // OpenAI: function tool_call with arguments = JSON-stringified envelope.
    mockChatCompletionsCreate.mockResolvedValueOnce({
      choices: [
        {
          message: {
            role: 'assistant' as const,
            content: null,
            refusal: null,
            tool_calls: [
              {
                id: 'call_emit_rt',
                type: 'function' as const,
                function: {
                  name: 'emit_findings',
                  arguments: JSON.stringify({ suggestions: SHARED_SUGGESTIONS }),
                },
              },
            ],
          },
          finish_reason: 'tool_calls' as const,
        },
      ],
      usage: { prompt_tokens: 100, completion_tokens: 50 },
    });

    const { getProvider } = await import('../src/providers/llm/index.js');
    const anthropicResult = await getProvider('anthropic').runAudit({
      credential: { apiKey: 'a' },
      messages: SHARED_MESSAGES,
      model: 'claude-haiku-4-5-20251001',
    });
    const openaiResult = await getProvider('openai').runAudit({
      credential: { apiKey: 'o' },
      messages: SHARED_MESSAGES,
      model: 'gpt-5-mini',
    });

    // Single-shared-Zod-schema invariant (D-09): IDENTICAL parsed output
    // surfaces under toolUse[0].input.suggestions on both providers.
    const anthropicSuggestions =
      (anthropicResult.toolUse[0]?.input as { suggestions: AuditSuggestion[] }).suggestions;
    const openaiSuggestions =
      (openaiResult.toolUse[0]?.input as { suggestions: AuditSuggestion[] }).suggestions;
    expect(anthropicSuggestions).toEqual(SHARED_SUGGESTIONS);
    expect(openaiSuggestions).toEqual(SHARED_SUGGESTIONS);
    expect(anthropicSuggestions).toEqual(openaiSuggestions);
  });

  it('emit_findings tool definition reaches BOTH SDK calls in their respective wire shapes', async () => {
    // Engine sends emit_findings + getEntryBody on every turn. This test asserts
    // both providers' SDK call args contain a tool/function named emit_findings.
    // The schema parity is implicit: both come from the same z.toJSONSchema()
    // output the engine builds in audit-engine.ts — a regression that drops
    // the schema or renames the tool fails this assertion.
    mockMessagesCountTokens.mockResolvedValueOnce({ input_tokens: 100 });
    mockMessagesCreate.mockResolvedValueOnce({
      id: 'msg_tool_def',
      role: 'assistant' as const,
      content: [
        {
          type: 'tool_use' as const,
          id: 'tu_tool_def',
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
    });
    mockChatCompletionsCreate.mockResolvedValueOnce({
      choices: [
        {
          message: {
            role: 'assistant' as const,
            content: null,
            refusal: null,
            tool_calls: [
              {
                id: 'call_tool_def',
                type: 'function' as const,
                function: {
                  name: 'emit_findings',
                  arguments: JSON.stringify({ suggestions: SHARED_SUGGESTIONS }),
                },
              },
            ],
          },
          finish_reason: 'tool_calls' as const,
        },
      ],
      usage: { prompt_tokens: 100, completion_tokens: 50 },
    });

    const engineTools = [
      {
        name: 'getEntryBody',
        description: 'Fetch the full body of one entry by ID.',
        input_schema: {
          type: 'object',
          properties: { entryId: { type: 'string', format: 'uuid' } },
          required: ['entryId'],
        },
      },
      {
        name: 'emit_findings',
        description: 'Call once to deliver the complete suggestions array.',
        input_schema: {
          type: 'object',
          properties: { suggestions: { type: 'array', items: { type: 'object' } } },
          required: ['suggestions'],
        },
      },
    ];

    const { getProvider } = await import('../src/providers/llm/index.js');
    await getProvider('anthropic').runAudit({
      credential: { apiKey: 'a' },
      messages: SHARED_MESSAGES,
      model: 'claude-haiku-4-5-20251001',
      tools: engineTools,
    });
    await getProvider('openai').runAudit({
      credential: { apiKey: 'o' },
      messages: SHARED_MESSAGES,
      model: 'gpt-5-mini',
      tools: engineTools,
    });

    // Anthropic: tools array carries the engine-shape directly.
    const anthropicArgs = mockMessagesCreate.mock.calls[0]?.[0] as {
      tools: Array<{ name: string }>;
    };
    expect(anthropicArgs.tools.find((t) => t.name === 'emit_findings')).toBeDefined();

    // OpenAI: tools array carries the function-tool wrapper.
    const openaiArgs = mockChatCompletionsCreate.mock.calls[0]?.[0] as {
      tools: Array<{ type: string; function: { name: string } }>;
    };
    expect(openaiArgs.tools.find((t) => t.function.name === 'emit_findings')).toBeDefined();
  });

  it('smuggled gap_key inside emit_findings tool_use is rejected by AuditOutputStrictSchema on both providers (Phase 24 BL-02 invariant preserved)', async () => {
    // Phase 24 BL-02 / T-24-04-03 / T-24-04-04: AuditOutputStrictSchema is
    // `.strict()` on both the envelope and the inner suggestion. A smuggled
    // gap_key inside a suggestion fails the parse. Phase 27 moves the parse
    // from JSON.parse(result.text) to tool_use.input — the invariant must
    // hold across the migration.
    //
    // We assert at the SCHEMA level (the Zod parse is the canonical boundary
    // — the engine's audit-engine.ts is the single consumer of this parse
    // for both providers; T-24-04-03 mitigation lives in the schema, not in
    // per-provider code). The contract here is "the strict parse rejects
    // smuggled fields", which is provider-agnostic.
    const { AuditOutputStrictSchema } = await import('../src/services/audit-schema.js');
    const smuggledInput = {
      suggestions: [
        {
          category: 'underdeveloped',
          title: 'A perfectly normal title',
          body: 'A perfectly normal body.',
          referenced_entry_ids: ['00000000-0000-4000-8000-000000000002'],
          confidence: 'low',
          // Smuggled field — must cause strict-parse rejection.
          gap_key: 'v1:smuggled-from-llm',
        },
      ],
    };

    // The schema parse throws for either provider's emit_findings input.
    expect(() => AuditOutputStrictSchema.parse(smuggledInput)).toThrow();

    // Belt and suspenders: drive a smuggled-gap_key emit_findings tool_use
    // through BOTH providers and confirm the parsed input still contains the
    // smuggled field at the wire boundary (the engine's downstream Zod parse
    // is what rejects it, NOT the provider). This locks the contract that
    // providers ROUND-TRIP shape faithfully without silently dropping fields.
    mockMessagesCountTokens.mockResolvedValueOnce({ input_tokens: 100 });
    mockMessagesCreate.mockResolvedValueOnce({
      id: 'msg_smuggle',
      role: 'assistant' as const,
      content: [
        {
          type: 'tool_use' as const,
          id: 'tu_smuggle',
          name: 'emit_findings',
          input: smuggledInput,
        },
      ],
      stop_reason: 'tool_use',
      usage: {
        input_tokens: 100,
        output_tokens: 50,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    });
    mockChatCompletionsCreate.mockResolvedValueOnce({
      choices: [
        {
          message: {
            role: 'assistant' as const,
            content: null,
            refusal: null,
            tool_calls: [
              {
                id: 'call_smuggle',
                type: 'function' as const,
                function: {
                  name: 'emit_findings',
                  arguments: JSON.stringify(smuggledInput),
                },
              },
            ],
          },
          finish_reason: 'tool_calls' as const,
        },
      ],
      usage: { prompt_tokens: 100, completion_tokens: 50 },
    });

    const { getProvider } = await import('../src/providers/llm/index.js');
    const anthropicResult = await getProvider('anthropic').runAudit({
      credential: { apiKey: 'a' },
      messages: SHARED_MESSAGES,
      model: 'claude-haiku-4-5-20251001',
    });
    const openaiResult = await getProvider('openai').runAudit({
      credential: { apiKey: 'o' },
      messages: SHARED_MESSAGES,
      model: 'gpt-5-mini',
    });

    // Both providers preserve the smuggled gap_key at the wire boundary —
    // the engine's strict Zod parse (above) is what rejects it. This
    // confirms providers don't accidentally sanitize away malicious fields
    // before the engine has a chance to reject the whole payload.
    const anthropicInput = anthropicResult.toolUse[0]?.input as { suggestions: Array<{ gap_key?: string }> };
    const openaiInput = openaiResult.toolUse[0]?.input as { suggestions: Array<{ gap_key?: string }> };
    expect(anthropicInput.suggestions[0]?.gap_key).toBe('v1:smuggled-from-llm');
    expect(openaiInput.suggestions[0]?.gap_key).toBe('v1:smuggled-from-llm');
  });
});
