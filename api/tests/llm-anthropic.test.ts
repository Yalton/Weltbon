/**
 * Phase 23-03 — AnthropicProvider unit tests.
 *
 * Coverage (PROVIDER-02 + PROVIDER-05 Anthropic side + PROVIDER-07 Anthropic side):
 *
 *   1. validate() success path via mocked messages.countTokens
 *   2. validate() error mapping for every SDK subclass listed in
 *      RESEARCH §"SDK Error Taxonomy → 7 LLMError Variants":
 *      AuthenticationError, PermissionDeniedError, RateLimitError,
 *      APIConnectionError, APIConnectionTimeoutError,
 *      APIError.status === 402 / 404 / 529, defensive UnknownProviderError
 *   3. estimate() returns input_tokens from countTokens
 *   4. runAudit() canonical wire-shape output (text + toolUse + usage + costUsd)
 *   5. cache_control gating — positive case (≥ MIN_CACHEABLE_TOKENS) +
 *      negative case (< MIN_CACHEABLE_TOKENS) — locks Pitfall #3 / T-23-03-02
 *   6. Post-call refusal check throws ContentBlockedBySafetyFilter — locks
 *      Pitfall #1 / T-23-03-03
 *   7. listModels() + pricing() consult PRICING.anthropic only
 *
 * Mocking strategy (RESEARCH §"Mock SDK Strategy for Contract Test"):
 *   - vi.mock('@anthropic-ai/sdk') replaces the default export with a callable
 *     that returns a controlled { messages: { create, countTokens } } stub.
 *   - The default mock also carries instanceof-checkable error subclasses
 *     attached as static members (Anthropic.AuthenticationError etc.), each
 *     extending a base error class so the production code's
 *     `err instanceof Anthropic.AuthenticationError` checks succeed.
 *   - Module-scope vi.fn() handles (mockCountTokens, mockCreate) let each
 *     it-body program return values / rejected values per case.
 *
 * vi.hoisted convention (mirrors api/tests/llm-keys.test.ts lines 29-31):
 *   AnthropicProvider does NOT transitively import api/src/db/client.ts, but
 *   matching project convention pre-emptively defuses any future re-import
 *   that could pull config.ts → env() at module evaluation time.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// CRITICAL — must be set BEFORE the *first* env() call in the process. config.ts
// caches `_env` on first call. This is defensive: anthropic.ts itself does not
// touch the DB / config layer, but the import chain through ../src/providers/llm/index.js
// could grow this dependency in future plans.
vi.hoisted(() => {
  process.env.LLM_KEY_ENCRYPTION_KEY = '0'.repeat(64);
});

// ---------------------------------------------------------------------------
// vi.mock '@anthropic-ai/sdk' — hoisted by Vitest above all imports.
// ---------------------------------------------------------------------------
//
// The mock provides:
//   - a callable default export (so `new Anthropic({ apiKey })` works)
//   - returning an instance with `messages.create` + `messages.countTokens`
//     that delegate to module-scope vi.fn handles each test re-programs
//   - instanceof-checkable error subclasses as static members on the default
//     so production code's `err instanceof Anthropic.AuthenticationError`
//     branches resolve correctly
//
// Pattern adapted from RESEARCH §Mock SDK Strategy and the existing
// llm-keys.test.ts vi.mock convention.

const { mockCreate, mockCountTokens, MockedErrors } = vi.hoisted(() => {
  const mockCreate = vi.fn();
  const mockCountTokens = vi.fn();

  // Build instanceof-checkable error subclasses. Each one extends Error so
  // production code's `err instanceof Anthropic.AuthenticationError` resolves
  // truthy against an instance constructed below.
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

  const MockedErrors = {
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

  return { mockCreate, mockCountTokens, MockedErrors };
});

vi.mock('@anthropic-ai/sdk', () => {
  // The Anthropic SDK's default export is a callable class. We expose it as a
  // function (vi.fn → mockImplementation) returning the messages stub, then
  // Object.assign the error subclasses so static-member instanceof checks work.
  const AnthropicMock = vi.fn().mockImplementation(() => ({
    messages: {
      create: mockCreate,
      countTokens: mockCountTokens,
    },
  }));
  Object.assign(AnthropicMock, MockedErrors);
  return { default: AnthropicMock };
});

// Canonical happy-path response fixture for runAudit (mirrors RESEARCH §Mock
// SDK Strategy lines 535-562). Single tool_use block, stop_reason: 'tool_use'.
const HAPPY_PATH_RESPONSE = {
  id: 'msg_mock',
  role: 'assistant' as const,
  content: [
    {
      type: 'tool_use' as const,
      id: 'tu_mock',
      name: 'emit_findings',
      input: {
        suggestions: [
          {
            category: 'missing-link',
            referencedEntryIds: ['entry-1', 'entry-2'],
            rationale: 'These two entries have no explicit connection.',
            evidence: 'Entry 1 mentions X; Entry 2 mentions Y.',
          },
        ],
      },
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

beforeEach(() => {
  mockCountTokens.mockReset();
  mockCreate.mockReset();
  // Sensible defaults for tests that don't override them.
  mockCountTokens.mockResolvedValue({ input_tokens: 0 });
  mockCreate.mockResolvedValue(HAPPY_PATH_RESPONSE);
});

describe('AnthropicProvider (PROVIDER-02 + PROVIDER-05 + PROVIDER-07)', () => {
  // -----------------------------------------------------------------------
  // validate() — happy path + 9 error variants
  // -----------------------------------------------------------------------

  it('validate succeeds when countTokens resolves', async () => {
    mockCountTokens.mockResolvedValueOnce({ input_tokens: 0 });
    const { getProvider } = await import('../src/providers/llm/index.js');
    await getProvider('anthropic').validate('sk-ant-test');
    expect(mockCountTokens).toHaveBeenCalledTimes(1);
    expect(mockCountTokens).toHaveBeenCalledWith({
      model: 'claude-haiku-4-5-20251001',
      messages: [{ role: 'user', content: 'hi' }],
    });
  });

  it('validate throws LLMProviderError with InvalidApiKey when AuthenticationError', async () => {
    mockCountTokens.mockRejectedValueOnce(new MockedErrors.AuthenticationError('401', 401));
    const { getProvider, LLMProviderError, LLMError } = await import(
      '../src/providers/llm/index.js'
    );
    try {
      await getProvider('anthropic').validate('bad');
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(LLMProviderError);
      expect((err as InstanceType<typeof LLMProviderError>).variant).toBe(LLMError.InvalidApiKey);
    }
  });

  it('validate throws InvalidApiKey when PermissionDeniedError', async () => {
    mockCountTokens.mockRejectedValueOnce(new MockedErrors.PermissionDeniedError('403', 403));
    const { getProvider, LLMProviderError, LLMError } = await import(
      '../src/providers/llm/index.js'
    );
    try {
      await getProvider('anthropic').validate('bad');
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(LLMProviderError);
      expect((err as InstanceType<typeof LLMProviderError>).variant).toBe(LLMError.InvalidApiKey);
    }
  });

  it('validate throws RateLimited when RateLimitError', async () => {
    mockCountTokens.mockRejectedValueOnce(new MockedErrors.RateLimitError('429', 429));
    const { getProvider, LLMProviderError, LLMError } = await import(
      '../src/providers/llm/index.js'
    );
    try {
      await getProvider('anthropic').validate('any');
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(LLMProviderError);
      expect((err as InstanceType<typeof LLMProviderError>).variant).toBe(LLMError.RateLimited);
    }
  });

  it('validate throws NetworkError when APIConnectionTimeoutError', async () => {
    mockCountTokens.mockRejectedValueOnce(new MockedErrors.APIConnectionTimeoutError('timeout'));
    const { getProvider, LLMProviderError, LLMError } = await import(
      '../src/providers/llm/index.js'
    );
    try {
      await getProvider('anthropic').validate('any');
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(LLMProviderError);
      expect((err as InstanceType<typeof LLMProviderError>).variant).toBe(LLMError.NetworkError);
    }
  });

  it('validate throws NetworkError when APIConnectionError', async () => {
    mockCountTokens.mockRejectedValueOnce(new MockedErrors.APIConnectionError('ECONNRESET'));
    const { getProvider, LLMProviderError, LLMError } = await import(
      '../src/providers/llm/index.js'
    );
    try {
      await getProvider('anthropic').validate('any');
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(LLMProviderError);
      expect((err as InstanceType<typeof LLMProviderError>).variant).toBe(LLMError.NetworkError);
    }
  });

  it('validate throws NetworkError when InternalServerError', async () => {
    mockCountTokens.mockRejectedValueOnce(new MockedErrors.InternalServerError('500', 500));
    const { getProvider, LLMProviderError, LLMError } = await import(
      '../src/providers/llm/index.js'
    );
    try {
      await getProvider('anthropic').validate('any');
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(LLMProviderError);
      expect((err as InstanceType<typeof LLMProviderError>).variant).toBe(LLMError.NetworkError);
    }
  });

  it('validate throws InsufficientCredits when APIError with status 402', async () => {
    mockCountTokens.mockRejectedValueOnce(new MockedErrors.APIError('402 billing_error', 402));
    const { getProvider, LLMProviderError, LLMError } = await import(
      '../src/providers/llm/index.js'
    );
    try {
      await getProvider('anthropic').validate('any');
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(LLMProviderError);
      expect((err as InstanceType<typeof LLMProviderError>).variant).toBe(
        LLMError.InsufficientCredits,
      );
    }
  });

  it('validate throws ModelNotAvailable when APIError with status 404', async () => {
    mockCountTokens.mockRejectedValueOnce(new MockedErrors.APIError('404', 404));
    const { getProvider, LLMProviderError, LLMError } = await import(
      '../src/providers/llm/index.js'
    );
    try {
      await getProvider('anthropic').validate('any');
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(LLMProviderError);
      expect((err as InstanceType<typeof LLMProviderError>).variant).toBe(
        LLMError.ModelNotAvailable,
      );
    }
  });

  it('validate throws NetworkError when APIError with status 529 (overloaded)', async () => {
    mockCountTokens.mockRejectedValueOnce(
      new MockedErrors.APIError('529 overloaded_error', 529),
    );
    const { getProvider, LLMProviderError, LLMError } = await import(
      '../src/providers/llm/index.js'
    );
    try {
      await getProvider('anthropic').validate('any');
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(LLMProviderError);
      expect((err as InstanceType<typeof LLMProviderError>).variant).toBe(LLMError.NetworkError);
    }
  });

  it('validate throws UnknownProviderError defensive fallback for non-SDK error', async () => {
    mockCountTokens.mockRejectedValueOnce(new Error('weird random non-SDK exception'));
    const { getProvider, LLMProviderError, LLMError } = await import(
      '../src/providers/llm/index.js'
    );
    try {
      await getProvider('anthropic').validate('any');
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(LLMProviderError);
      expect((err as InstanceType<typeof LLMProviderError>).variant).toBe(
        LLMError.UnknownProviderError,
      );
    }
  });

  // -----------------------------------------------------------------------
  // estimate() — happy path (countTokens passthrough)
  // -----------------------------------------------------------------------

  it('estimate returns input_tokens from countTokens', async () => {
    mockCountTokens.mockResolvedValueOnce({ input_tokens: 1234 });
    const { getProvider } = await import('../src/providers/llm/index.js');
    const result = await getProvider('anthropic').estimate({
      apiKey: 'k',
      messages: [{ role: 'user', content: 'hello world' }],
    });
    expect(result).toBe(1234);
  });

  it('estimate with new system-aware shape forwards system to countTokens top-level param (Test B)', async () => {
    mockCountTokens.mockResolvedValueOnce({ input_tokens: 200 });
    const { getProvider } = await import('../src/providers/llm/index.js');
    const result = await getProvider('anthropic').estimate({
      apiKey: 'k',
      messages: [{ role: 'user', content: 'q' }],
      system: 'top-level system text',
    });
    // system must be forwarded as top-level parameter to countTokens
    expect(mockCountTokens.mock.calls[0]?.[0]?.system).toBe('top-level system text');
    // role:'system' must NOT appear inside the messages[] array
    const msgsArg = mockCountTokens.mock.calls[0]?.[0]?.messages as Array<{ role: string }>;
    expect(msgsArg.every((m) => m.role !== 'system')).toBe(true);
    expect(result).toBe(200);
  });

  // -----------------------------------------------------------------------
  // runAudit() — wire-shape, cache gating (positive + negative), refusal
  // -----------------------------------------------------------------------

  it('runAudit returns canonical wire shape from a single create call', async () => {
    // Below MIN_CACHEABLE_TOKENS so no cache_control is applied; happy-path
    // create response carries 100 input + 50 output tokens.
    mockCountTokens.mockResolvedValueOnce({ input_tokens: 100 });
    mockCreate.mockResolvedValueOnce(HAPPY_PATH_RESPONSE);

    const { getProvider } = await import('../src/providers/llm/index.js');
    const result = await getProvider('anthropic').runAudit({
      apiKey: 'k',
      messages: [{ role: 'user', content: 'find gaps' }],
      model: 'claude-haiku-4-5-20251001',
    });

    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(result.toolUse).toHaveLength(1);
    expect(result.toolUse[0]?.name).toBe('emit_findings');
    expect(result.text).toBe('');
    expect(result.usage.inputTokens).toBe(100);
    expect(result.usage.outputTokens).toBe(50);
    expect(result.usage.cacheCreationInputTokens).toBe(0);
    expect(result.usage.cacheReadInputTokens).toBe(0);
    // claude-haiku-4-5 PRICING: input 1.0 / output 5.0 per 1M tokens.
    // Cache fields are 0, so cost = (100 * 1.0 + 50 * 5.0) / 1_000_000 = 0.00035
    expect(result.costUsd).toBeCloseTo((100 * 1.0 + 50 * 5.0) / 1_000_000, 10);
  });

  it('runAudit with leading system message extracts system before countTokens (Test A — cache-ineligible)', async () => {
    // 100 tokens < MIN_CACHEABLE_TOKENS (4096) — cache branch does not apply.
    mockCountTokens.mockResolvedValueOnce({ input_tokens: 100 });
    mockCreate.mockResolvedValueOnce(HAPPY_PATH_RESPONSE);

    const { getProvider } = await import('../src/providers/llm/index.js');
    const result = await getProvider('anthropic').runAudit({
      apiKey: 'k',
      messages: [
        { role: 'system', content: 'SYSTEM_TEXT' },
        { role: 'user', content: 'q' },
      ],
      model: 'claude-haiku-4-5-20251001',
    });

    // countTokens must receive system as top-level parameter
    expect(mockCountTokens.mock.calls[0]?.[0]?.system).toBe('SYSTEM_TEXT');
    // role:'system' must NOT appear inside the messages[] array to countTokens
    const countTokensMsgs = mockCountTokens.mock.calls[0]?.[0]?.messages as Array<{ role: string }>;
    expect(countTokensMsgs.every((m) => m.role !== 'system')).toBe(true);
    expect(countTokensMsgs).toEqual([{ role: 'user', content: 'q' }]);
    // runAudit must complete and return canonical RunAuditResult
    expect(result.toolUse).toHaveLength(1);
    expect(result.toolUse[0]?.name).toBe('emit_findings');
  });

  it('runAudit applies cache_control when estimate >= MIN_CACHEABLE_TOKENS AND first message is system', async () => {
    // 5000 tokens >= MIN_CACHEABLE_TOKENS (4096) — cache breakpoint should apply.
    mockCountTokens.mockResolvedValueOnce({ input_tokens: 5000 });
    mockCreate.mockResolvedValueOnce(HAPPY_PATH_RESPONSE);

    const { getProvider } = await import('../src/providers/llm/index.js');
    await getProvider('anthropic').runAudit({
      apiKey: 'k',
      messages: [
        { role: 'system', content: 'long system prompt content here ...' },
        { role: 'user', content: 'q' },
      ],
      model: 'claude-haiku-4-5-20251001',
    });

    const createArgs = mockCreate.mock.calls[0]?.[0];
    // System extracted into dedicated parameter with cache_control: ephemeral.
    expect(createArgs.system).toEqual([
      expect.objectContaining({
        type: 'text',
        text: 'long system prompt content here ...',
        cache_control: { type: 'ephemeral' },
      }),
    ]);
    // System message stripped from the messages array.
    expect(createArgs.messages).toEqual([{ role: 'user', content: 'q' }]);
  });

  it('runAudit with leading system message: countTokens receives system top-level AND cache_control applied (Test C — cache-eligible)', async () => {
    // 5000 tokens >= MIN_CACHEABLE_TOKENS — cache branch applies + system-extraction
    mockCountTokens.mockResolvedValueOnce({ input_tokens: 5000 });
    mockCreate.mockResolvedValueOnce(HAPPY_PATH_RESPONSE);

    const { getProvider } = await import('../src/providers/llm/index.js');
    const result = await getProvider('anthropic').runAudit({
      apiKey: 'k',
      messages: [
        { role: 'system', content: 'long system' },
        { role: 'user', content: 'q' },
      ],
      model: 'claude-haiku-4-5-20251001',
    });

    // countTokens must also receive system as top-level (not just messages.create)
    expect(mockCountTokens.mock.calls[0]?.[0]?.system).toBe('long system');
    // messages.create must receive system with cache_control (existing invariant)
    const createArgs = mockCreate.mock.calls[0]?.[0];
    expect(createArgs.system).toEqual([
      expect.objectContaining({
        type: 'text',
        text: 'long system',
        cache_control: { type: 'ephemeral' },
      }),
    ]);
    // runAudit completes and returns canonical result
    expect(result.toolUse).toHaveLength(1);
  });

  it('runAudit does NOT apply cache_control when estimate < MIN_CACHEABLE_TOKENS', async () => {
    // 1000 tokens < MIN_CACHEABLE_TOKENS (4096) — silent no-op risk per Pitfall #3.
    mockCountTokens.mockResolvedValueOnce({ input_tokens: 1000 });
    mockCreate.mockResolvedValueOnce(HAPPY_PATH_RESPONSE);

    const { getProvider } = await import('../src/providers/llm/index.js');
    await getProvider('anthropic').runAudit({
      apiKey: 'k',
      messages: [
        { role: 'system', content: 'short system prompt' },
        { role: 'user', content: 'q' },
      ],
      model: 'claude-haiku-4-5-20251001',
    });

    const createArgs = mockCreate.mock.calls[0]?.[0];
    // System block is still extracted to the dedicated parameter, but WITHOUT
    // cache_control because the estimate was below threshold.
    expect(createArgs.system).toEqual([
      { type: 'text', text: 'short system prompt' },
    ]);
    // No cache_control field anywhere in the system block.
    expect(createArgs.system[0].cache_control).toBeUndefined();
    expect(createArgs.messages).toEqual([{ role: 'user', content: 'q' }]);
  });

  it("runAudit throws ContentBlockedBySafetyFilter when response.stop_reason === 'refusal'", async () => {
    mockCountTokens.mockResolvedValueOnce({ input_tokens: 50 });
    mockCreate.mockResolvedValueOnce({
      id: 'msg_refusal',
      role: 'assistant',
      content: [],
      stop_reason: 'refusal',
      usage: {
        input_tokens: 50,
        output_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    });
    const { getProvider, LLMProviderError, LLMError } = await import(
      '../src/providers/llm/index.js'
    );
    try {
      await getProvider('anthropic').runAudit({
        apiKey: 'k',
        messages: [{ role: 'user', content: 'q' }],
        model: 'claude-haiku-4-5-20251001',
      });
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(LLMProviderError);
      expect((err as InstanceType<typeof LLMProviderError>).variant).toBe(
        LLMError.ContentBlockedBySafetyFilter,
      );
    }
  });

  it("runAudit throws UnknownProviderError when response.stop_reason === 'max_tokens' (truncation guard — Test E)", async () => {
    // Below MIN_CACHEABLE_TOKENS to skip the cache branch — keeps the test focused
    // on the truncation guard, not on cache_control logic.
    mockCountTokens.mockResolvedValueOnce({ input_tokens: 50 });
    mockCreate.mockResolvedValueOnce({
      id: 'msg_trunc',
      role: 'assistant',
      content: [],
      stop_reason: 'max_tokens',
      usage: {
        input_tokens: 50,
        output_tokens: 4096,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    });
    const { getProvider, LLMProviderError, LLMError } = await import(
      '../src/providers/llm/index.js'
    );
    try {
      await getProvider('anthropic').runAudit({
        apiKey: 'k',
        messages: [{ role: 'user', content: 'q' }],
        model: 'claude-haiku-4-5-20251001',
      });
      expect.fail('should have thrown — truncated response must not return as success');
    } catch (err) {
      expect(err).toBeInstanceOf(LLMProviderError);
      expect((err as InstanceType<typeof LLMProviderError>).variant).toBe(
        LLMError.UnknownProviderError,
      );
      expect((err as InstanceType<typeof LLMProviderError>).message).toMatch(
        /truncated|max_tokens/i,
      );
    }
  });

  // -----------------------------------------------------------------------
  // Phase 27 D-09 — emit_findings tool wire shape
  // -----------------------------------------------------------------------

  it('runAudit forwards engine tools (including emit_findings) to messages.create tools[] (Phase 27 D-09)', async () => {
    mockCountTokens.mockResolvedValueOnce({ input_tokens: 100 });
    mockCreate.mockResolvedValueOnce(HAPPY_PATH_RESPONSE);

    const { getProvider } = await import('../src/providers/llm/index.js');
    // Simulate the engine handing both tools through opts.tools — the
    // production engine passes [getEntryBodyTool, emitFindingsTool] on
    // every turn (see audit-engine.ts post-Phase-27).
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
    await getProvider('anthropic').runAudit({
      apiKey: 'k',
      messages: [{ role: 'user', content: 'find gaps' }],
      model: 'claude-haiku-4-5-20251001',
      tools: engineTools,
    });

    // Assert messages.create was called with `tools` containing BOTH engine
    // tools verbatim. Anthropic accepts the engine-shape directly (name +
    // description + input_schema), no wire translation needed.
    const createArgs = mockCreate.mock.calls[0]?.[0] as {
      tools: Array<{ name: string; description: string; input_schema: unknown }>;
    };
    expect(createArgs.tools).toBeDefined();
    expect(createArgs.tools).toHaveLength(2);
    const emitTool = createArgs.tools.find((t) => t.name === 'emit_findings');
    expect(emitTool).toBeDefined();
    expect(emitTool!.description).toContain('suggestions');
    expect(emitTool!.input_schema).toEqual(engineTools[1].input_schema);
    const getEntryTool = createArgs.tools.find((t) => t.name === 'getEntryBody');
    expect(getEntryTool).toBeDefined();
    expect(getEntryTool!.input_schema).toEqual(engineTools[0].input_schema);
  });

  it('runAudit extracts emit_findings tool_use into engine-facing { id, name, input } shape', async () => {
    mockCountTokens.mockResolvedValueOnce({ input_tokens: 100 });
    mockCreate.mockResolvedValueOnce({
      id: 'msg_emit',
      role: 'assistant' as const,
      content: [
        {
          type: 'tool_use' as const,
          id: 'tu_emit_anth',
          name: 'emit_findings',
          input: { suggestions: [{ category: 'underdeveloped' }] },
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
    const result = await getProvider('anthropic').runAudit({
      apiKey: 'k',
      messages: [{ role: 'user', content: 'q' }],
      model: 'claude-haiku-4-5-20251001',
    });

    // Engine-facing normalized shape: { id, name, input } with parsed input.
    expect(result.toolUse).toHaveLength(1);
    expect(result.toolUse[0].id).toBe('tu_emit_anth');
    expect(result.toolUse[0].name).toBe('emit_findings');
    expect(result.toolUse[0].input).toEqual({
      suggestions: [{ category: 'underdeveloped' }],
    });
  });

  // -----------------------------------------------------------------------
  // listModels() + pricing()
  // -----------------------------------------------------------------------

  it('listModels returns 3 models matching PRICING.anthropic keys', async () => {
    const { getProvider } = await import('../src/providers/llm/index.js');
    const models = getProvider('anthropic').listModels();
    expect(models).toHaveLength(3);
    expect(models.map((m) => m.id)).toEqual(
      expect.arrayContaining(['claude-haiku-4-5-20251001', 'claude-sonnet-4-6', 'claude-opus-4-7']),
    );
  });

  it('pricing(model) returns entry for known model', async () => {
    const { getProvider } = await import('../src/providers/llm/index.js');
    const p = getProvider('anthropic').pricing('claude-haiku-4-5-20251001');
    expect(p).toBeDefined();
    expect(p?.inputUsdPer1M).toBe(1.0);
    expect(p?.outputUsdPer1M).toBe(5.0);
  });

  it('pricing(model) returns undefined for unknown model', async () => {
    const { getProvider } = await import('../src/providers/llm/index.js');
    const p = getProvider('anthropic').pricing('claude-fake');
    expect(p).toBeUndefined();
  });

  // -----------------------------------------------------------------------
  // Phase 27 D-05/D-06: unpriced-model guard split (T-23-03-05 revised)
  // -----------------------------------------------------------------------

  it('runAudit does NOT throw ModelNotAvailable for live-but-unpriced model; yields costUsd=0 (Phase 27 D-06)', async () => {
    // Use a model ID that is NOT in PRICING.anthropic — simulates a new live release.
    mockCountTokens.mockResolvedValueOnce({ input_tokens: 100 });
    mockCreate.mockResolvedValueOnce(HAPPY_PATH_RESPONSE);

    const { getProvider } = await import('../src/providers/llm/index.js');

    // Must NOT throw — unpriced-but-live model should proceed
    const result = await getProvider('anthropic').runAudit({
      apiKey: 'k',
      messages: [{ role: 'user', content: 'find gaps' }],
      model: 'claude-nova-future-unpriced',  // not in PRICING
    });

    // costUsd must be 0 (safe for SUM math — keeps audit_runs.cost_usd at 0.0000)
    expect(result.costUsd).toBe(0);
    // Usage is still returned (engine still records token counts for observability)
    expect(result.usage.inputTokens).toBe(100);
    expect(result.usage.outputTokens).toBe(50);
    // The run completed with toolUse output
    expect(result.toolUse).toHaveLength(1);
  });

  // -----------------------------------------------------------------------
  // Phase 27 D-12: forceTool / tool_choice wiring (Task 1)
  // -----------------------------------------------------------------------

  it('runAudit sends tool_choice:{type:"tool",name} when forceTool is set (Phase 27 D-12)', async () => {
    // Below MIN_CACHEABLE_TOKENS to skip cache branch — test focuses on tool_choice.
    mockCountTokens.mockResolvedValueOnce({ input_tokens: 50 });
    mockCreate.mockResolvedValueOnce(HAPPY_PATH_RESPONSE);

    const { getProvider } = await import('../src/providers/llm/index.js');

    await getProvider('anthropic').runAudit({
      apiKey: 'k',
      messages: [{ role: 'user', content: 'find gaps' }],
      model: 'claude-haiku-4-5-20251001',
      forceTool: { type: 'tool', name: 'emit_findings' },
    });

    const createArgs = mockCreate.mock.calls[0]?.[0];
    // The provider MUST pass tool_choice to messages.create when forceTool is set.
    expect(createArgs.tool_choice).toEqual({ type: 'tool', name: 'emit_findings' });
  });

  it('runAudit does NOT send tool_choice when forceTool is unset (Phase 27 D-12)', async () => {
    // Without forceTool, tool_choice must be absent (auto).
    mockCountTokens.mockResolvedValueOnce({ input_tokens: 50 });
    mockCreate.mockResolvedValueOnce(HAPPY_PATH_RESPONSE);

    const { getProvider } = await import('../src/providers/llm/index.js');

    await getProvider('anthropic').runAudit({
      apiKey: 'k',
      messages: [{ role: 'user', content: 'find gaps' }],
      model: 'claude-haiku-4-5-20251001',
      // forceTool intentionally absent
    });

    const createArgs = mockCreate.mock.calls[0]?.[0];
    // No tool_choice key when forceTool is absent — auto is the default.
    expect(createArgs.tool_choice).toBeUndefined();
  });

  it('runAudit parses emit_findings tool_use.input into toolUse[0] when forceTool used (Phase 27 D-12)', async () => {
    mockCountTokens.mockResolvedValueOnce({ input_tokens: 50 });
    // emit_findings response with structured findings in tool_use.input
    const emitFindingsResponse = {
      id: 'msg_emit',
      role: 'assistant' as const,
      content: [
        {
          type: 'tool_use' as const,
          id: 'tu_emit',
          name: 'emit_findings',
          input: {
            suggestions: [
              {
                category: 'missing-link',
                title: 'Missing connection',
                body: 'No link between A and B.',
                referenced_entry_ids: ['entry-a', 'entry-b'],
                confidence: 'high',
              },
            ],
          },
        },
      ],
      stop_reason: 'tool_use' as const,
      usage: {
        input_tokens: 50,
        output_tokens: 20,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    };
    mockCreate.mockResolvedValueOnce(emitFindingsResponse);

    const { getProvider } = await import('../src/providers/llm/index.js');

    const result = await getProvider('anthropic').runAudit({
      apiKey: 'k',
      messages: [{ role: 'user', content: 'find gaps' }],
      model: 'claude-haiku-4-5-20251001',
      forceTool: { type: 'tool', name: 'emit_findings' },
    });

    // The emit_findings tool call must appear in result.toolUse
    expect(result.toolUse).toHaveLength(1);
    expect(result.toolUse[0]?.name).toBe('emit_findings');
    // input is the already-parsed object — no string extraction
    expect(result.toolUse[0]?.input).toEqual({
      suggestions: [
        {
          category: 'missing-link',
          title: 'Missing connection',
          body: 'No link between A and B.',
          referenced_entry_ids: ['entry-a', 'entry-b'],
          confidence: 'high',
        },
      ],
    });
  });
});
