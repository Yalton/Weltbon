
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

const { mockChatCompletionsParse, mockChatCompletionsCreate, mockModelsList, MockedErrors } = vi.hoisted(() => {
  const mockChatCompletionsParse = vi.fn();


  // function-tool calling. The `parse` mock is kept for backward-compat
  // shape but should never be invoked from runAudit() anymore.
  const mockChatCompletionsCreate = vi.fn();
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

  return { mockChatCompletionsParse, mockChatCompletionsCreate, mockModelsList, MockedErrors };
});

vi.mock('openai', () => {
  // The OpenAI SDK's default export is a callable class. We expose it as a
  // function (vi.fn → mockImplementation) returning the chat + models stubs,
  // then Object.assign the error subclasses so static-member instanceof
  // checks (`OpenAI.AuthenticationError`) work in production code.
  //

  // path) and `parse` (legacy — response_format path, retained for the Zod-v4
  // smoke test in this file). runAudit() now uses `create`; the `parse` mock
  // remains attached so the smoke test that exercises the real
  // openai/helpers/zod helper still has a callable handle.
  const OpenAIMock = vi.fn().mockImplementation(() => ({
    chat: {
      completions: {
        create: mockChatCompletionsCreate,
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


// runAudit now calls chat.completions.create() and consumes tool_calls
// (function-tool calling). The model "invokes" emit_findings to deliver the
// final answer; arguments is a JSON string per OpenAI spec.
const HAPPY_PATH_RESPONSE = {
  choices: [
    {
      message: {
        role: 'assistant' as const,
        content: null,
        refusal: null,
        tool_calls: [
          {
            id: 'call_emit_findings_mock',
            type: 'function' as const,
            function: {
              name: 'emit_findings',
              arguments: JSON.stringify({
                suggestions: [
                  {
                    category: 'missing-link' as const,
                    referencedEntryIds: ['entry-1', 'entry-2'],
                    rationale: 'These two entries have no explicit connection.',
                    evidence: 'Entry 1 mentions X; Entry 2 mentions Y.',
                  },
                ],
              }),
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

beforeEach(() => {
  mockModelsList.mockReset();
  mockChatCompletionsParse.mockReset();
  mockChatCompletionsCreate.mockReset();
  // Sensible defaults for tests that don't override them.
  mockModelsList.mockResolvedValue({ data: [], object: 'list' });
  mockChatCompletionsCreate.mockResolvedValue(HAPPY_PATH_RESPONSE);
});

describe('OpenAIProvider (PROVIDER-03 + PROVIDER-05 + PROVIDER-07)', () => {
  // -----------------------------------------------------------------------
  // validate() — happy path + 9 error variants
  // -----------------------------------------------------------------------

  it('validate succeeds when models.list resolves', async () => {
    mockModelsList.mockResolvedValueOnce({ data: [], object: 'list' });
    const { getProvider } = await import('../src/providers/llm/index.js');
    await getProvider('openai').validate({ apiKey: 'sk-test' });
    expect(mockModelsList).toHaveBeenCalledTimes(1);
  });

  it('validate throws LLMProviderError with InvalidApiKey when AuthenticationError', async () => {
    mockModelsList.mockRejectedValueOnce(new MockedErrors.AuthenticationError('401', 401));
    const { getProvider, LLMProviderError, LLMError } = await import(
      '../src/providers/llm/index.js'
    );
    try {
      await getProvider('openai').validate({ apiKey: 'bad' });
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
      await getProvider('openai').validate({ apiKey: 'bad' });
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
      await getProvider('openai').validate({ apiKey: 'any' });
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
      await getProvider('openai').validate({ apiKey: 'any' });
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
      await getProvider('openai').validate({ apiKey: 'any' });
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
      await getProvider('openai').validate({ apiKey: 'any' });
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
      await getProvider('openai').validate({ apiKey: 'any' });
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
      await getProvider('openai').validate({ apiKey: 'any' });
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
      await getProvider('openai').validate({ apiKey: 'any' });
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
      credential: { apiKey: 'k' },
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
      credential: { apiKey: 'k' },
      messages: [{ role: 'user', content: 'no network please' }],
    });
    expect(mockModelsList).not.toHaveBeenCalled();
    expect(mockChatCompletionsParse).not.toHaveBeenCalled();
    expect(mockChatCompletionsCreate).not.toHaveBeenCalled();
  });

  it('estimate with system-aware shape includes system contribution in count (Test D — PROVIDER-07 preserved)', async () => {
    const { getProvider } = await import('../src/providers/llm/index.js');
    const messages = [{ role: 'user' as const, content: 'short' }];
    const systemText = 'a much longer system prompt that adds many tokens to the local count';

    // Baseline: estimate without system
    const baseCount = await getProvider('openai').estimate({
      credential: { apiKey: 'k' },
      messages,
    });

    // System-aware: estimate with system should be strictly greater
    const systemCount = await getProvider('openai').estimate({
      credential: { apiKey: 'k' },
      messages,
      system: systemText,
    });

    expect(systemCount).toBeGreaterThan(baseCount);
    // Zero-network-call invariant preserved (PROVIDER-07)
    expect(mockModelsList).not.toHaveBeenCalled();
    expect(mockChatCompletionsParse).not.toHaveBeenCalled();
    expect(mockChatCompletionsCreate).not.toHaveBeenCalled();
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

  it('runAudit calls chat.completions.create once and returns canonical wire shape', async () => {
    mockChatCompletionsCreate.mockResolvedValueOnce(HAPPY_PATH_RESPONSE);

    const { getProvider } = await import('../src/providers/llm/index.js');
    const result = await getProvider('openai').runAudit({
      credential: { apiKey: 'k' },
      messages: [{ role: 'user', content: 'find gaps' }],
      model: 'gpt-5-mini',
    });

    expect(mockChatCompletionsCreate).toHaveBeenCalledTimes(1);
    // The legacy parse path must NEVER be invoked from runAudit anymore.
    expect(mockChatCompletionsParse).not.toHaveBeenCalled();
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
    mockChatCompletionsCreate.mockResolvedValueOnce({
      choices: [
        {
          message: {
            role: 'assistant' as const,
            content: null,
            refusal: null,
            tool_calls: [
              {
                id: 'call_emit_empty',
                type: 'function' as const,
                function: { name: 'emit_findings', arguments: '{"suggestions":[]}' },
              },
            ],
          },
          finish_reason: 'tool_calls' as const,
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
      credential: { apiKey: 'k' },
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
    mockChatCompletionsCreate.mockResolvedValueOnce({
      choices: [
        {
          message: { role: 'assistant', content: null, refusal: null, tool_calls: [] },
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
        credential: { apiKey: 'k' },
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
    mockChatCompletionsCreate.mockResolvedValueOnce({
      choices: [
        {
          message: {
            role: 'assistant' as const,
            content: null,
            refusal: 'I cannot help with that.',
            tool_calls: [],
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
        credential: { apiKey: 'k' },
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

  it("runAudit throws UnknownProviderError when finish_reason === 'length' (truncation guard — Test F)", async () => {
    // finish_reason 'length' signals the response was cut off at the token
    // limit. tool_calls (if any) may have incomplete arguments JSON.
    // The truncation guard must throw BEFORE callers see a partial response.
    mockChatCompletionsCreate.mockResolvedValueOnce({
      choices: [
        {
          message: { role: 'assistant', content: null, refusal: null, tool_calls: [] },
          finish_reason: 'length' as const,
        },
      ],
      usage: { prompt_tokens: 4000, completion_tokens: 4096 },
    });
    const { getProvider, LLMProviderError, LLMError } = await import(
      '../src/providers/llm/index.js'
    );
    try {
      await getProvider('openai').runAudit({
        credential: { apiKey: 'k' },
        messages: [{ role: 'user', content: 'q' }],
        model: 'gpt-5-mini',
      });
      expect.fail('should have thrown — truncated response must not return as success');
    } catch (err) {
      expect(err).toBeInstanceOf(LLMProviderError);
      expect((err as InstanceType<typeof LLMProviderError>).variant).toBe(
        LLMError.UnknownProviderError,
      );
      expect((err as InstanceType<typeof LLMProviderError>).message).toMatch(
        /truncated|token limit|length/i,
      );
    }
  });

  // -----------------------------------------------------------------------

  // -----------------------------------------------------------------------

  it('runAudit forwards engine tools as OpenAI function-tool array', async () => {
    mockChatCompletionsCreate.mockResolvedValueOnce(HAPPY_PATH_RESPONSE);

    const { getProvider } = await import('../src/providers/llm/index.js');
    // Simulate the engine handing both tools through opts.tools — the
    // production engine passes [getEntryBodyTool, emitFindingsTool] on every
    // turn (see audit-engine.ts post-Phase-27). The provider must wire each
    // engine-shape tool into OpenAI's function-tool shape verbatim.
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
    await getProvider('openai').runAudit({
      credential: { apiKey: 'k' },
      messages: [{ role: 'user', content: 'find gaps' }],
      model: 'gpt-5-mini',
      tools: engineTools,
    });

    // Assert chat.completions.create was called with the `tools` parameter
    // containing OpenAI's function-tool shape; emit_findings + getEntryBody
    // BOTH flow through alongside each other.
    const callArgs = mockChatCompletionsCreate.mock.calls[0]?.[0] as {
      tools: Array<{ type: string; function: { name: string; description: string; parameters: unknown } }>;
    };
    expect(callArgs.tools).toBeDefined();
    expect(callArgs.tools).toHaveLength(2);
    const emitTool = callArgs.tools.find((t) => t.function.name === 'emit_findings');
    expect(emitTool).toBeDefined();
    expect(emitTool!.type).toBe('function');
    expect(emitTool!.function.description).toContain('suggestions');
    // The parameters slot carries the engine's input_schema verbatim (single
    // shared Zod schema, per-provider wire wrapper — D-09).
    expect(emitTool!.function.parameters).toEqual(engineTools[1].input_schema);
    const getEntryTool = callArgs.tools.find((t) => t.function.name === 'getEntryBody');
    expect(getEntryTool).toBeDefined();
    expect(getEntryTool!.function.parameters).toEqual(engineTools[0].input_schema);
  });

  it('runAudit normalizes OpenAI tool_calls into engine-facing { id, name, input } shape', async () => {
    mockChatCompletionsCreate.mockResolvedValueOnce({
      choices: [
        {
          message: {
            role: 'assistant',
            content: null,
            refusal: null,
            tool_calls: [
              {
                id: 'call_abc123',
                type: 'function' as const,
                function: {
                  name: 'emit_findings',
                  arguments: JSON.stringify({ suggestions: [{ category: 'underdeveloped' }] }),
                },
              },
            ],
          },
          finish_reason: 'tool_calls' as const,
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    });

    const { getProvider } = await import('../src/providers/llm/index.js');
    const result = await getProvider('openai').runAudit({
      credential: { apiKey: 'k' },
      messages: [{ role: 'user', content: 'q' }],
      model: 'gpt-5-mini',
    });

    // Engine-facing normalized shape — IDENTICAL to Anthropic's tool_use:
    expect(result.toolUse).toHaveLength(1);
    expect(result.toolUse[0].id).toBe('call_abc123');
    expect(result.toolUse[0].name).toBe('emit_findings');
    // `input` is the parsed JSON object (NOT the string), matching the
    // single-shared-Zod-schema contract (D-09).
    expect(result.toolUse[0].input).toEqual({
      suggestions: [{ category: 'underdeveloped' }],
    });
  });

  it('runAudit throws UnknownProviderError when tool_call arguments are malformed JSON', async () => {
    mockChatCompletionsCreate.mockResolvedValueOnce({
      choices: [
        {
          message: {
            role: 'assistant',
            content: null,
            refusal: null,
            tool_calls: [
              {
                id: 'call_bad_json',
                type: 'function' as const,
                function: {
                  name: 'emit_findings',
                  arguments: '{this is not valid JSON',
                },
              },
            ],
          },
          finish_reason: 'tool_calls' as const,
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    });

    const { getProvider, LLMProviderError, LLMError } = await import(
      '../src/providers/llm/index.js'
    );
    try {
      await getProvider('openai').runAudit({
        credential: { apiKey: 'k' },
        messages: [{ role: 'user', content: 'q' }],
        model: 'gpt-5-mini',
      });
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(LLMProviderError);
      expect((err as InstanceType<typeof LLMProviderError>).variant).toBe(
        LLMError.UnknownProviderError,
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
