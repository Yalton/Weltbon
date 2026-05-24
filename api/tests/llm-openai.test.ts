/**
 * Phase 23-04 — OpenAIProvider unit tests.
 *
 * Coverage (PROVIDER-03 + PROVIDER-05 OpenAI side + PROVIDER-07 OpenAI side):
 *
 *   1. validate() success path via mocked client.models.list
 *   2. validate() error mapping for every SDK subclass listed in RESEARCH
 *      §"SDK Error Taxonomy → 7 LLMError Variants" OpenAI table:
 *      AuthenticationError, PermissionDeniedError, RateLimitError,
 *      APIConnectionError, InternalServerError, NotFoundError,
 *      UnprocessableEntityError, APIError.status === 402, and
 *      a defensive UnknownProviderError fallback for non-SDK errors
 *   3. estimate() returns a local js-tiktoken count with ZERO network calls
 *      (PROVIDER-07 locked: SDK methods never invoked during estimate)
 *   4. ZOD V4 COMPATIBILITY SMOKE CHECK — exercises real zod 4.1.4 +
 *      openai/helpers/zod's zodResponseFormat at test time to close
 *      Pitfall #5 empirically at landing, not at runtime in production
 *   5. runAudit() canonical wire-shape output (text + toolUse + usage + costUsd)
 *   6. runAudit() cost math with cached input tokens (RESEARCH Pattern 7)
 *   7. DUAL safety-filter check — both finish_reason === 'content_filter'
 *      and message.refusal cause ContentBlockedBySafetyFilter (T-23-04-03)
 *   8. listModels() + pricing() consult PRICING.openai only
 *
 * Mocking strategy (mirrors llm-anthropic.test.ts pattern, RESEARCH §"Mock
 * SDK Strategy for Contract Test"):
 *   - vi.mock('openai') replaces the default export with a callable that
 *     returns a controlled { chat.completions.parse, models.list } stub.
 *   - The default mock also carries instanceof-checkable error subclasses
 *     attached as static members (OpenAI.AuthenticationError etc.), each
 *     extending a base APIError class so production code's
 *     `err instanceof OpenAI.AuthenticationError` branches resolve correctly.
 *   - Module-scope vi.fn() handles (mockModelsList, mockChatCompletionsParse)
 *     let each it-body program return values / rejected values per case.
 *   - vi.mock('openai/helpers/zod') passes through schema + name as a
 *     plausible response_format object — Tests (m) verify the REAL
 *     zodResponseFormat works with the project's installed Zod 4.1.4 in
 *     parallel by using vi.importActual.
 *
 * vi.hoisted convention (mirrors api/tests/llm-keys.test.ts + llm-anthropic.test.ts):
 *   OpenAIProvider does NOT transitively import api/src/db/client.ts, but
 *   matching project convention pre-emptively defuses any future re-import
 *   that could pull config.ts → env() at module evaluation time.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// CRITICAL — must be set BEFORE the *first* env() call in the process. This
// is defensive: openai.ts itself does not touch the DB / config layer, but
// the import chain through ../src/providers/llm/index.js could grow this
// dependency in future plans.
vi.hoisted(() => {
  process.env.LLM_KEY_ENCRYPTION_KEY = '0'.repeat(64);
});

// ---------------------------------------------------------------------------
// vi.mock 'openai' — hoisted by Vitest above all imports.
// ---------------------------------------------------------------------------
//
// The mock provides:
//   - a callable default export (so `new OpenAI({ apiKey })` works)
//   - returning an instance with `chat.completions.parse` + `models.list`
//     that delegate to module-scope vi.fn handles each test re-programs
//   - instanceof-checkable error subclasses as static members on the default
//     so production code's `err instanceof OpenAI.AuthenticationError`
//     branches resolve correctly
//
// Pattern adapted from RESEARCH §Mock SDK Strategy and the proven
// llm-anthropic.test.ts convention.

const { mockChatCompletionsParse, mockModelsList, MockedErrors } = vi.hoisted(() => {
  const mockChatCompletionsParse = vi.fn();
  const mockModelsList = vi.fn();

  // Build instanceof-checkable error subclasses. Each one extends Error so
  // production code's `err instanceof OpenAI.AuthenticationError` resolves
  // truthy against an instance constructed below. The MockAPIError class
  // carries the `status` property the production mapper branches on.
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

  const MockedErrors = {
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

  return { mockChatCompletionsParse, mockModelsList, MockedErrors };
});

vi.mock('openai', () => {
  // The OpenAI SDK's default export is a callable class. We expose it as a
  // function (vi.fn → mockImplementation) returning the chat + models stubs,
  // then Object.assign the error subclasses so static-member instanceof
  // checks (`OpenAI.AuthenticationError`) work in production code.
  const OpenAIMock = vi.fn().mockImplementation(() => ({
    chat: {
      completions: {
        parse: mockChatCompletionsParse,
      },
    },
    models: {
      list: mockModelsList,
    },
  }));
  Object.assign(OpenAIMock, MockedErrors);
  return { default: OpenAIMock };
});

// Mock the helper so `zodResponseFormat(AuditOutputSchema, 'audit_output')`
// returns a plausible response_format object without touching the real
// helper (the dedicated smoke-check test below uses vi.importActual to drive
// the REAL helper against the REAL Zod 4.1.4 — Pitfall #5 closure).
vi.mock('openai/helpers/zod', () => ({
  zodResponseFormat: vi.fn((schema, name) => ({
    type: 'json_schema',
    json_schema: { schema, name },
  })),
}));

// Canonical happy-path response fixture for runAudit. One parsed suggestion
// inside `message.parsed`, normal stop. Mirrors the contract-test fixture in
// RESEARCH §Mock SDK Strategy lines 568-600.
const HAPPY_PATH_RESPONSE = {
  choices: [
    {
      message: {
        parsed: {
          suggestions: [
            {
              category: 'missing-link' as const,
              referencedEntryIds: ['entry-1', 'entry-2'],
              rationale: 'These two entries have no explicit connection.',
              evidence: 'Entry 1 mentions X; Entry 2 mentions Y.',
            },
          ],
        },
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

beforeEach(() => {
  mockModelsList.mockReset();
  mockChatCompletionsParse.mockReset();
  // Sensible defaults for tests that don't override them.
  mockModelsList.mockResolvedValue({ data: [], object: 'list' });
  mockChatCompletionsParse.mockResolvedValue(HAPPY_PATH_RESPONSE);
});

describe('OpenAIProvider (PROVIDER-03 + PROVIDER-05 + PROVIDER-07)', () => {
  // -----------------------------------------------------------------------
  // validate() — happy path + 9 error variants
  // -----------------------------------------------------------------------

  it('validate succeeds when models.list resolves', async () => {
    mockModelsList.mockResolvedValueOnce({ data: [], object: 'list' });
    const { getProvider } = await import('../src/providers/llm/index.js');
    await getProvider('openai').validate('sk-test');
    expect(mockModelsList).toHaveBeenCalledTimes(1);
  });

  it('validate throws LLMProviderError with InvalidApiKey when AuthenticationError', async () => {
    mockModelsList.mockRejectedValueOnce(new MockedErrors.AuthenticationError('401', 401));
    const { getProvider, LLMProviderError, LLMError } = await import(
      '../src/providers/llm/index.js'
    );
    try {
      await getProvider('openai').validate('bad');
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(LLMProviderError);
      expect((err as InstanceType<typeof LLMProviderError>).variant).toBe(LLMError.InvalidApiKey);
    }
  });

  it('validate throws InvalidApiKey when PermissionDeniedError', async () => {
    mockModelsList.mockRejectedValueOnce(new MockedErrors.PermissionDeniedError('403', 403));
    const { getProvider, LLMProviderError, LLMError } = await import(
      '../src/providers/llm/index.js'
    );
    try {
      await getProvider('openai').validate('bad');
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(LLMProviderError);
      expect((err as InstanceType<typeof LLMProviderError>).variant).toBe(LLMError.InvalidApiKey);
    }
  });

  it('validate throws RateLimited when RateLimitError', async () => {
    mockModelsList.mockRejectedValueOnce(new MockedErrors.RateLimitError('429', 429));
    const { getProvider, LLMProviderError, LLMError } = await import(
      '../src/providers/llm/index.js'
    );
    try {
      await getProvider('openai').validate('any');
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(LLMProviderError);
      expect((err as InstanceType<typeof LLMProviderError>).variant).toBe(LLMError.RateLimited);
    }
  });

  it('validate throws NetworkError when APIConnectionError', async () => {
    mockModelsList.mockRejectedValueOnce(new MockedErrors.APIConnectionError('ECONNRESET'));
    const { getProvider, LLMProviderError, LLMError } = await import(
      '../src/providers/llm/index.js'
    );
    try {
      await getProvider('openai').validate('any');
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(LLMProviderError);
      expect((err as InstanceType<typeof LLMProviderError>).variant).toBe(LLMError.NetworkError);
    }
  });

  it('validate throws NetworkError when InternalServerError', async () => {
    mockModelsList.mockRejectedValueOnce(new MockedErrors.InternalServerError('500', 500));
    const { getProvider, LLMProviderError, LLMError } = await import(
      '../src/providers/llm/index.js'
    );
    try {
      await getProvider('openai').validate('any');
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(LLMProviderError);
      expect((err as InstanceType<typeof LLMProviderError>).variant).toBe(LLMError.NetworkError);
    }
  });

  it('validate throws ModelNotAvailable when NotFoundError', async () => {
    mockModelsList.mockRejectedValueOnce(new MockedErrors.NotFoundError('404', 404));
    const { getProvider, LLMProviderError, LLMError } = await import(
      '../src/providers/llm/index.js'
    );
    try {
      await getProvider('openai').validate('any');
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(LLMProviderError);
      expect((err as InstanceType<typeof LLMProviderError>).variant).toBe(
        LLMError.ModelNotAvailable,
      );
    }
  });

  it('validate throws ModelNotAvailable when UnprocessableEntityError', async () => {
    mockModelsList.mockRejectedValueOnce(
      new MockedErrors.UnprocessableEntityError('422', 422),
    );
    const { getProvider, LLMProviderError, LLMError } = await import(
      '../src/providers/llm/index.js'
    );
    try {
      await getProvider('openai').validate('any');
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(LLMProviderError);
      expect((err as InstanceType<typeof LLMProviderError>).variant).toBe(
        LLMError.ModelNotAvailable,
      );
    }
  });

  it('validate throws InsufficientCredits when APIError with status 402', async () => {
    mockModelsList.mockRejectedValueOnce(new MockedErrors.APIError('402 billing_error', 402));
    const { getProvider, LLMProviderError, LLMError } = await import(
      '../src/providers/llm/index.js'
    );
    try {
      await getProvider('openai').validate('any');
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(LLMProviderError);
      expect((err as InstanceType<typeof LLMProviderError>).variant).toBe(
        LLMError.InsufficientCredits,
      );
    }
  });

  it('validate throws UnknownProviderError defensive fallback for non-SDK error', async () => {
    mockModelsList.mockRejectedValueOnce(new Error('weird random non-SDK exception'));
    const { getProvider, LLMProviderError, LLMError } = await import(
      '../src/providers/llm/index.js'
    );
    try {
      await getProvider('openai').validate('any');
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(LLMProviderError);
      expect((err as InstanceType<typeof LLMProviderError>).variant).toBe(
        LLMError.UnknownProviderError,
      );
    }
  });

  // -----------------------------------------------------------------------
  // estimate() — local computation, zero network calls (PROVIDER-07)
  // -----------------------------------------------------------------------

  it('estimate returns local tiktoken count (positive integer for short string)', async () => {
    const { getProvider } = await import('../src/providers/llm/index.js');
    const result = await getProvider('openai').estimate({
      apiKey: 'k',
      messages: [{ role: 'user', content: 'hello world from tests' }],
    });
    expect(typeof result).toBe('number');
    expect(Number.isInteger(result)).toBe(true);
    expect(result).toBeGreaterThan(0);
    // Sanity bound — short string + 4-overhead + 2-priming should be < 100
    expect(result).toBeLessThan(100);
  });

  it('estimate does NOT call any SDK method (PROVIDER-07 local-only)', async () => {
    const { getProvider } = await import('../src/providers/llm/index.js');
    await getProvider('openai').estimate({
      apiKey: 'k',
      messages: [{ role: 'user', content: 'no network please' }],
    });
    expect(mockModelsList).not.toHaveBeenCalled();
    expect(mockChatCompletionsParse).not.toHaveBeenCalled();
  });

  it('estimate with system-aware shape includes system contribution in count (Test D — PROVIDER-07 preserved)', async () => {
    const { getProvider } = await import('../src/providers/llm/index.js');
    const messages = [{ role: 'user' as const, content: 'short' }];
    const systemText = 'a much longer system prompt that adds many tokens to the local count';

    // Baseline: estimate without system
    const baseCount = await getProvider('openai').estimate({
      apiKey: 'k',
      messages,
    });

    // System-aware: estimate with system should be strictly greater
    const systemCount = await getProvider('openai').estimate({
      apiKey: 'k',
      messages,
      system: systemText,
    });

    expect(systemCount).toBeGreaterThan(baseCount);
    // Zero-network-call invariant preserved (PROVIDER-07)
    expect(mockModelsList).not.toHaveBeenCalled();
    expect(mockChatCompletionsParse).not.toHaveBeenCalled();
  });

  // -----------------------------------------------------------------------
  // ZOD V4 COMPATIBILITY SMOKE CHECK (Pitfall #5)
  // -----------------------------------------------------------------------

  it('ZOD V4 COMPATIBILITY: real zodResponseFormat accepts a Zod 4.1.4 schema and returns a valid response_format object', async () => {
    // Pull the REAL helper + REAL Zod (bypass our vi.mock above) to verify
    // empirically that openai@6.38.x's zodResponseFormat works with the
    // project's installed Zod 4.1.4. If this fails, Pitfall #5 has fired
    // and the implementer must switch to `import { z } from 'zod/v3'` for
    // AuditOutputSchema only (rest of codebase stays on Zod 4).
    const realZodHelpers = await vi.importActual<typeof import('openai/helpers/zod')>(
      'openai/helpers/zod',
    );
    const realZod = await vi.importActual<typeof import('zod')>('zod');

    const smokeSchema = realZod.z.object({
      x: realZod.z.string(),
      y: realZod.z.number(),
    });

    // The call must not throw at runtime (the type check is enforced by the
    // module loader at build time — this catches both compile- and
    // run-time failures Pitfall #5 warns about).
    const responseFormat = realZodHelpers.zodResponseFormat(smokeSchema, 'smoke_test');
    expect(responseFormat).toBeDefined();
    expect(responseFormat.type).toBe('json_schema');
    // The SDK wraps in json_schema.{ name, schema, strict } per OpenAI spec.
    expect(responseFormat.json_schema).toBeDefined();
    expect(responseFormat.json_schema.name).toBe('smoke_test');
  });

  // -----------------------------------------------------------------------
  // runAudit() — wire-shape, cost math, dual safety-filter check
  // -----------------------------------------------------------------------

  it('runAudit calls chat.completions.parse once and returns canonical wire shape', async () => {
    mockChatCompletionsParse.mockResolvedValueOnce(HAPPY_PATH_RESPONSE);

    const { getProvider } = await import('../src/providers/llm/index.js');
    const result = await getProvider('openai').runAudit({
      apiKey: 'k',
      messages: [{ role: 'user', content: 'find gaps' }],
      model: 'gpt-5-mini',
    });

    expect(mockChatCompletionsParse).toHaveBeenCalledTimes(1);
    expect(result.toolUse).toHaveLength(1);
    expect(result.toolUse[0]?.name).toBe('emit_findings');
    const suggestions = result.toolUse[0]?.input.suggestions as Array<{ category: string }>;
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0]?.category).toBe('missing-link');
    expect(result.usage.inputTokens).toBe(100);
    expect(result.usage.outputTokens).toBe(50);
    expect(result.usage.cacheCreationInputTokens).toBe(0); // OpenAI has no cache-write surface
    expect(result.usage.cacheReadInputTokens).toBe(0); // no cached tokens in fixture
    // gpt-5-mini PRICING: input 0.25 / output 2.0 / cachedInput 0.025 per 1M.
    // Cost = (100 * 0.25 + 50 * 2.0) / 1_000_000 = 0.000125
    expect(result.costUsd).toBeCloseTo((100 * 0.25 + 50 * 2.0) / 1_000_000, 10);
  });

  it('runAudit cost computed correctly with cached prompt tokens (RESEARCH Pattern 7)', async () => {
    mockChatCompletionsParse.mockResolvedValueOnce({
      choices: [
        {
          message: {
            parsed: { suggestions: [] },
            refusal: null,
            content: '',
          },
          finish_reason: 'stop' as const,
        },
      ],
      usage: {
        prompt_tokens: 100,
        completion_tokens: 50,
        prompt_tokens_details: { cached_tokens: 40 },
      },
    });

    const { getProvider } = await import('../src/providers/llm/index.js');
    const result = await getProvider('openai').runAudit({
      apiKey: 'k',
      messages: [{ role: 'user', content: 'q' }],
      model: 'gpt-5-mini',
    });

    // Non-cached input = (100 - 40) * 0.25 / 1_000_000 = 15e-6
    // Cached input    = 40 * 0.025 / 1_000_000        = 1e-6
    // Output          = 50 * 2.0 / 1_000_000          = 100e-6
    // Total                                            = 116e-6 = 0.000116
    const expected = (60 * 0.25 + 40 * 0.025 + 50 * 2.0) / 1_000_000;
    expect(result.costUsd).toBeCloseTo(expected, 10);
    expect(result.usage.cacheReadInputTokens).toBe(40);
    expect(result.usage.inputTokens).toBe(100);
  });

  it("runAudit throws ContentBlockedBySafetyFilter when finish_reason === 'content_filter'", async () => {
    mockChatCompletionsParse.mockResolvedValueOnce({
      choices: [
        {
          message: { parsed: null, refusal: null, content: '' },
          finish_reason: 'content_filter' as const,
        },
      ],
      usage: { prompt_tokens: 50, completion_tokens: 0 },
    });
    const { getProvider, LLMProviderError, LLMError } = await import(
      '../src/providers/llm/index.js'
    );
    try {
      await getProvider('openai').runAudit({
        apiKey: 'k',
        messages: [{ role: 'user', content: 'q' }],
        model: 'gpt-5-mini',
      });
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(LLMProviderError);
      expect((err as InstanceType<typeof LLMProviderError>).variant).toBe(
        LLMError.ContentBlockedBySafetyFilter,
      );
    }
  });

  it('runAudit throws ContentBlockedBySafetyFilter when message.refusal is non-null', async () => {
    mockChatCompletionsParse.mockResolvedValueOnce({
      choices: [
        {
          message: {
            parsed: null,
            refusal: 'I cannot help with that.',
            content: '',
          },
          finish_reason: 'stop' as const,
        },
      ],
      usage: { prompt_tokens: 50, completion_tokens: 10 },
    });
    const { getProvider, LLMProviderError, LLMError } = await import(
      '../src/providers/llm/index.js'
    );
    try {
      await getProvider('openai').runAudit({
        apiKey: 'k',
        messages: [{ role: 'user', content: 'q' }],
        model: 'gpt-5-mini',
      });
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(LLMProviderError);
      expect((err as InstanceType<typeof LLMProviderError>).variant).toBe(
        LLMError.ContentBlockedBySafetyFilter,
      );
    }
  });

  // -----------------------------------------------------------------------
  // listModels() + pricing()
  // -----------------------------------------------------------------------

  it('listModels returns 3 models matching PRICING.openai keys', async () => {
    const { getProvider } = await import('../src/providers/llm/index.js');
    const models = getProvider('openai').listModels();
    expect(models).toHaveLength(3);
    expect(models.map((m) => m.id)).toEqual(
      expect.arrayContaining(['gpt-5-mini', 'gpt-5', 'gpt-5-pro']),
    );
  });

  it('pricing(model) returns entry for known model gpt-5-mini', async () => {
    const { getProvider } = await import('../src/providers/llm/index.js');
    const p = getProvider('openai').pricing('gpt-5-mini');
    expect(p).toBeDefined();
    expect(p?.inputUsdPer1M).toBe(0.25);
    expect(p?.outputUsdPer1M).toBe(2.0);
    expect(p?.cachedInputUsdPer1M).toBe(0.025);
  });

  it('pricing(model) returns undefined for unknown model', async () => {
    const { getProvider } = await import('../src/providers/llm/index.js');
    const p = getProvider('openai').pricing('gpt-9');
    expect(p).toBeUndefined();
  });
});
