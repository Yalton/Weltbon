import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const chatFixture = JSON.parse(
  readFileSync(resolve(here, 'fixtures/ollama/chat-tool-call.json'), 'utf8'),
);

describe('toOllamaTools', () => {
  it('translates an engine tool into Ollama function shape', async () => {
    const { toOllamaTools } = await import('../src/providers/llm/ollama-wire.js');
    const out = toOllamaTools([
      {
        name: 'getEntryBody',
        description: 'fetch one entry',
        input_schema: { type: 'object', properties: {} },
      },
    ]);
    expect(out).toEqual([
      {
        type: 'function',
        function: {
          name: 'getEntryBody',
          description: 'fetch one entry',
          parameters: { type: 'object', properties: {} },
        },
      },
    ]);
  });
});

describe('fromOllamaToolCalls', () => {
  it('surfaces the real call id from a REAL response, not a synthesized one', async () => {
    // This is the test that would have failed against the plan's original
    // (wrong) assumption: a synthesized `ollama-0` id would satisfy every
    // other assertion here while silently discarding the server's real id,
    // which is exactly the kind of bug that only shows up as a mis-paired
    // tool_result several turns later.
    const { fromOllamaToolCalls } = await import('../src/providers/llm/ollama-wire.js');
    const calls = fromOllamaToolCalls(chatFixture.message);
    expect(calls).toHaveLength(1);
    expect(calls[0].id).toBe('call_a9wwonwx');
    expect(calls[0].name).toBe('emit_findings');
  });

  it('parses the real (object-shaped) arguments into input, not just checks typeof', async () => {
    const { fromOllamaToolCalls } = await import('../src/providers/llm/ollama-wire.js');
    const calls = fromOllamaToolCalls(chatFixture.message);
    const suggestions = (calls[0].input as { suggestions?: Array<{ title?: string }> })
      .suggestions;
    expect(Array.isArray(suggestions)).toBe(true);
    expect(suggestions?.[0]?.title).toBe('Missing Description for Aldebaran');
  });

  it('returns an empty array when the model emitted only prose', async () => {
    const { fromOllamaToolCalls } = await import('../src/providers/llm/ollama-wire.js');
    expect(fromOllamaToolCalls({ content: 'just text', role: 'assistant' })).toEqual([]);
  });

  it('falls back to a positional id only when the server genuinely omits one', async () => {
    // No live response has been observed without an id — this is defensive
    // coverage for the fallback branch itself, not a claim about real wire
    // shape. Kept a hand-rolled object deliberately: the real-fixture tests
    // above are what pin the actual server behavior.
    const { fromOllamaToolCalls } = await import('../src/providers/llm/ollama-wire.js');
    const calls = fromOllamaToolCalls({
      tool_calls: [{ function: { name: 'emit_findings', arguments: { a: 1 } } }],
    });
    expect(calls[0].id).toBe('ollama-0');
  });

  it('still accepts a JSON-string arguments payload (defensive — OpenAI shape)', async () => {
    const { fromOllamaToolCalls } = await import('../src/providers/llm/ollama-wire.js');
    const calls = fromOllamaToolCalls({
      tool_calls: [
        { id: 'x1', function: { name: 'emit_findings', arguments: '{"suggestions":[]}' } },
      ],
    });
    expect(calls[0].input).toEqual({ suggestions: [] });
  });

  it('throws a normalized error on unparseable string arguments rather than silently yielding {}', async () => {
    const { fromOllamaToolCalls } = await import('../src/providers/llm/ollama-wire.js');
    expect(() =>
      fromOllamaToolCalls({
        tool_calls: [{ id: 'x1', function: { name: 'emit_findings', arguments: '{not json' } }],
      }),
    ).toThrow(/unparseable/i);
  });
});

describe('chooseNumCtx', () => {
  it('adds output headroom above the prompt rather than sizing to the prompt exactly', async () => {
    const { chooseNumCtx } = await import('../src/providers/llm/ollama-wire.js');

    // which `chooseNumCtx = (est) => est` satisfies — i.e. it passed with
    // OUTPUT_HEADROOM_TOKENS deleted entirely, the one thing it names. A
    // window sized to the prompt with no room for the answer means the model
    // starts generating into a full context, which is the truncation D-4
    // exists to prevent arriving from the other end. Pinned exactly:
    // 5000 + OUTPUT_HEADROOM_TOKENS (2048).
    expect(chooseNumCtx(5000, 40960)).toBe(7048);
  });

  it('refuses a prompt larger than the architectural maximum', async () => {
    const { chooseNumCtx } = await import('../src/providers/llm/ollama-wire.js');
    expect(() => chooseNumCtx(50000, 40960)).toThrow(/context/i);
  });

  it('falls back to a conservative CEILING when the architectural maximum is unknown', async () => {
    const { chooseNumCtx } = await import('../src/providers/llm/ollama-wire.js');

    // `toBeGreaterThanOrEqual(1000)`, which says nothing at all about the
    // fallback this test is named for — it passed whether CONSERVATIVE_MAX
    // was 8192, infinity, or absent. The behaviour that matters when
    // /api/show reports no context_length is that a ceiling still applies:
    // without one, an unknown-context model would accept any num_ctx we asked
    // for and truncate silently at whatever its real window turned out to be.
    expect(chooseNumCtx(1000, null)).toBe(3048);
    // Above CONSERVATIVE_MAX (8192) the fallback must still refuse:
    // 7000 + 2048 = 9048 > 8192.
    expect(() => chooseNumCtx(7000, null)).toThrow(/8192/);
  });
});
