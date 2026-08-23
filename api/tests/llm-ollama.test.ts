import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const fx = (n: string) => JSON.parse(readFileSync(resolve(here, `fixtures/ollama/${n}.json`), 'utf8'));
const chatFixture = fx('chat-tool-call');

afterEach(() => {
  vi.unstubAllGlobals();
});

/**
 * `/api/show` is a POST whose body names the model (`{"model": "..."}`) — the
 * same URL serves every model, so a fake that dispatches on URL alone cannot
 * tell `qwen3:32b` from `llava:latest` and would let both resolve to
 * whichever single `/api/show` fixture happened to be registered (fix round 1:
 * that was exactly this file's original bug — see git history). Routes for
 * `/api/show` are therefore keyed `'/api/show:<model>'` and matched against
 * the parsed request body's `model` field; every other route (just `/api/tags`
 * here) is still matched by plain URL substring.
 */
function fakeFetch(routes: Record<string, unknown>) {
  return async (url: string, init?: RequestInit): Promise<Response> => {
    if (url.includes('/api/show')) {
      const body = init?.body ? (JSON.parse(init.body as string) as { model?: string }) : {};
      const key = `/api/show:${body.model ?? ''}`;
      if (!(key in routes)) return new Response('not found', { status: 404 });
      return new Response(JSON.stringify(routes[key]), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    const key = Object.keys(routes).find((k) => url.includes(k));
    if (key === undefined) return new Response('not found', { status: 404 });
    return new Response(JSON.stringify(routes[key]), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };
}

describe('listOllamaModels', () => {
  it('marks a tools-capable model usable and a vision-only model not', async () => {
    const { listOllamaModels } = await import('../src/providers/llm/ollama.js');
    const models = await listOllamaModels(
      'http://box:11434',
      fakeFetch({
        '/api/tags': { models: [{ name: 'qwen3:32b' }, { name: 'llava:latest' }] },
        '/api/show:qwen3:32b': fx('show-qwen3-32b'),
        '/api/show:llava:latest': fx('show-llava'),
      }) as unknown as typeof fetch,
    );
    const q = models.find((m) => m.name === 'qwen3:32b');
    const l = models.find((m) => m.name === 'llava:latest');
    expect(q?.supportsTools).toBe(true);
    expect(l?.supportsTools).toBe(false);
  });

  it('reports the architectural context length, which is NOT the runtime window', async () => {
    // Recorded so nobody later "fixes" this by feeding it to num_ctx: the
    // runtime window is num_ctx, which we always set ourselves (spec D-4).
    const { listOllamaModels } = await import('../src/providers/llm/ollama.js');
    const models = await listOllamaModels(
      'http://box:11434',
      fakeFetch({
        '/api/tags': { models: [{ name: 'qwen3:32b' }] },
        '/api/show:qwen3:32b': fx('show-qwen3-32b'),
      }) as unknown as typeof fetch,
    );
    expect(models[0].contextLength).toBe(40960);
  });
});

describe('OllamaProvider.validate', () => {
  it('rejects an unreachable server as NetworkError, not InvalidApiKey', async () => {
    const { getProvider } = await import('../src/providers/llm/index.js');
    const { LLMError } = await import('../src/providers/llm/interface.js');
    const p = getProvider('ollama');
    await expect(
      p.validate({ baseUrl: 'http://127.0.0.1:1' }),
    ).rejects.toMatchObject({ variant: LLMError.NetworkError });
  });

  it('rejects a missing baseUrl before any network call', async () => {
    const { getProvider } = await import('../src/providers/llm/index.js');
    const { LLMError } = await import('../src/providers/llm/interface.js');
    const p = getProvider('ollama');
    // Pinning the variant (not just "throws") is what actually enforces the
    // "before any network call" half of this test's name: a regression that
    // instead attempted a connection and surfaced NetworkError would still
    // satisfy a bare `.rejects.toThrow()`.
    await expect(p.validate({})).rejects.toMatchObject({ variant: LLMError.InvalidApiKey });
  });
});

describe('OllamaProvider pricing surface', () => {
  it('lists nothing and prices nothing, so the engine takes its cost_unknown path', async () => {
    const { getProvider } = await import('../src/providers/llm/index.js');
    const p = getProvider('ollama');
    expect(p.listModels()).toEqual([]);
    expect(p.pricing('qwen3:32b')).toBeUndefined();
  });
});

describe('OllamaProvider.runAudit', () => {
  /**
   * Real chat-tool-call fixture registered under model 'qwen3:14b' (the
   * fixture's own model), paired with the show-qwen3-32b fixture for
   * capability/context data — its content (capabilities include 'tools',
   * qwen3.context_length 40960) is unrelated to the 14b/32b size distinction
   * this test doesn't care about; only the shape matters here.
   */
  function routesWithChat(chatBody: unknown) {
    return {
      '/api/tags': { models: [{ name: 'qwen3:14b' }] },
      '/api/show:qwen3:14b': fx('show-qwen3-32b'),
      '/api/chat': chatBody,
    };
  }

  it('returns text EMPTY (not the thinking field) against the REAL captured tool-call response', async () => {
    // This is the test that would fail if a future "helpful" change merged
    // `message.thinking` into `text`: the fixture's `message.content` is ''
    // while `message.thinking` is 2095 chars of prose. Surfacing thinking as
    // text would falsely trip the audit engine's D-10 "prose in a final
    // turn" contract violation. Asserting text === '' directly against this
    // real fixture is what pins that — a hand-written fixture without a
    // thinking field could never catch this regression.
    const { getProvider } = await import('../src/providers/llm/index.js');
    vi.stubGlobal('fetch', fakeFetch(routesWithChat(chatFixture)));
    const p = getProvider('ollama');
    const result = await p.runAudit({
      credential: { baseUrl: 'http://box:11434' },
      model: 'qwen3:14b',
      messages: [{ role: 'user', content: 'One entry has no description. Emit one finding.' }],
    });
    expect(result.text).toBe('');
  });

  it('surfaces the canonical toolUse shape with the REAL call id, usage, and zero cost', async () => {
    const { getProvider } = await import('../src/providers/llm/index.js');
    vi.stubGlobal('fetch', fakeFetch(routesWithChat(chatFixture)));
    const p = getProvider('ollama');
    const result = await p.runAudit({
      credential: { baseUrl: 'http://box:11434' },
      model: 'qwen3:14b',
      messages: [{ role: 'user', content: 'One entry has no description. Emit one finding.' }],
    });
    expect(result.toolUse).toEqual([
      {
        id: 'call_a9wwonwx',
        name: 'emit_findings',
        input: {
          suggestions: [
            {
              title: 'Missing Description for Aldebaran',
              detail: expect.stringContaining('Aldebaran'),
            },
          ],
        },
      },
    ]);
    // prompt_eval_count / eval_count from the fixture, mapped without loss.
    expect(result.usage).toEqual({
      inputTokens: 208,
      outputTokens: 530,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
    });
    // Always zero for Ollama — the engine's cost_unknown path expects it.
    expect(result.costUsd).toBe(0);
  });

  it('sets an explicit num_ctx on the /api/chat request rather than trusting a server default', async () => {
    const { getProvider } = await import('../src/providers/llm/index.js');
    let capturedBody: { options?: { num_ctx?: number } } | undefined;
    vi.stubGlobal(
      'fetch',
      async (url: string, init?: RequestInit) => {
        if (typeof url === 'string' && url.includes('/api/chat')) {
          capturedBody = JSON.parse(init?.body as string);
          return new Response(JSON.stringify(chatFixture), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        return fakeFetch(routesWithChat(chatFixture))(url, init);
      },
    );
    const p = getProvider('ollama');
    await p.runAudit({
      credential: { baseUrl: 'http://box:11434' },
      model: 'qwen3:14b',
      messages: [{ role: 'user', content: 'short prompt' }],
    });
    // A regression that dropped `options.num_ctx` (letting Ollama fall back
    // to its own default, commonly 2048/4096) would silently truncate
    // context on any audit whose prompt exceeds that default — this is the
    // one place that failure mode is caught.
    expect(typeof capturedBody?.options?.num_ctx).toBe('number');
    expect(capturedBody?.options?.num_ctx).toBeGreaterThan(0);
  });

  it('accounts for a large tool schema in num_ctx sizing, not just the prompt (fix round 1)', async () => {
    // A regression that sizes num_ctx from opts.messages alone (ignoring
    // opts.tools) would pass every assertion in the test above — tools ARE
    // serialized onto the wire (see that test) but were NOT counted toward
    // sizing until this fix. A model near its architectural ceiling could
    // then pass chooseNumCtx on the prompt alone and still get silently
    // truncated once the (uncounted) tool schema is added on the wire —
    // exactly the failure D-4 exists to make impossible, not merely
    // unlikely. Proven red/green against the fix: reverting the toolTokens
    // addition in ollama.ts's runAudit makes withTools === withoutTools,
    // failing this assertion.
    const { getProvider } = await import('../src/providers/llm/index.js');

    async function capturedNumCtx(tools?: unknown[]): Promise<number> {
      let capturedBody: { options?: { num_ctx?: number } } | undefined;
      vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
        if (typeof url === 'string' && url.includes('/api/chat')) {
          capturedBody = JSON.parse(init?.body as string);
          return new Response(JSON.stringify(chatFixture), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        return fakeFetch(routesWithChat(chatFixture))(url, init);
      });
      const p = getProvider('ollama');
      await p.runAudit({
        credential: { baseUrl: 'http://box:11434' },
        model: 'qwen3:14b',
        messages: [{ role: 'user', content: 'short prompt' }],
        tools,
      });
      return capturedBody!.options!.num_ctx!;
    }

    const withoutTools = await capturedNumCtx(undefined);
    // A JSON Schema shaped like what z.toJSONSchema would actually produce
    // for a real audit tool — many properties, not a toy one-field object —
    // so the size difference below cannot pass by accident or noise.
    const bigProperties: Record<string, unknown> = {};
    for (let i = 0; i < 40; i++) {
      bigProperties[`field${i}`] = {
        type: 'string',
        description: `A fairly verbose description of field ${i}, long enough to matter.`,
      };
    }
    const withTools = await capturedNumCtx([
      {
        name: 'emit_findings',
        description: 'Call once when ready to deliver findings.',
        input_schema: {
          type: 'object',
          properties: bigProperties,
          required: Object.keys(bigProperties),
        },
      },
    ]);

    // The schema above stringifies to roughly 3500+ chars, ~900+ tokens at
    // the chars/4 heuristic — comfortably bigger than any incidental noise.
    expect(withTools - withoutTools).toBeGreaterThan(500);
  });

  it('throws ModelNotAvailable when no model is selected, before any network call', async () => {
    const { getProvider } = await import('../src/providers/llm/index.js');
    const { LLMError } = await import('../src/providers/llm/interface.js');
    vi.stubGlobal('fetch', async () => {
      throw new Error('should not be called');
    });
    const p = getProvider('ollama');
    await expect(
      p.runAudit({ credential: { baseUrl: 'http://box:11434' }, messages: [] }),
    ).rejects.toMatchObject({ variant: LLMError.ModelNotAvailable });
  });

  it('throws ModelNotAvailable when the selected model is no longer installed', async () => {
    const { getProvider } = await import('../src/providers/llm/index.js');
    const { LLMError } = await import('../src/providers/llm/interface.js');
    vi.stubGlobal('fetch', fakeFetch({ '/api/tags': { models: [] } }));
    const p = getProvider('ollama');
    await expect(
      p.runAudit({
        credential: { baseUrl: 'http://box:11434' },
        model: 'qwen3:14b',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    ).rejects.toMatchObject({ variant: LLMError.ModelNotAvailable });
  });

  it('throws ModelNotAvailable when the selected model cannot tool-call', async () => {
    const { getProvider } = await import('../src/providers/llm/index.js');
    const { LLMError } = await import('../src/providers/llm/interface.js');
    vi.stubGlobal(
      'fetch',
      fakeFetch({
        '/api/tags': { models: [{ name: 'llava:latest' }] },
        '/api/show:llava:latest': fx('show-llava'),
      }),
    );
    const p = getProvider('ollama');
    await expect(
      p.runAudit({
        credential: { baseUrl: 'http://box:11434' },
        model: 'llava:latest',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    ).rejects.toMatchObject({ variant: LLMError.ModelNotAvailable });
  });

  it('refuses an audit whose estimated prompt cannot fit the model context, before calling /api/chat', async () => {
    const { getProvider } = await import('../src/providers/llm/index.js');
    const { LLMError } = await import('../src/providers/llm/interface.js');
    let chatCalled = false;
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      if (typeof url === 'string' && url.includes('/api/chat')) chatCalled = true;
      // A tiny context length (from a hand-shaped /api/show reply, not the
      // qwen3 fixture) so even a short prompt cannot fit once the fixed
      // output headroom is added — this exercises chooseNumCtx's throw path
      // wired through runAudit, not just the unit-tested function alone.
      return fakeFetch({
        '/api/tags': { models: [{ name: 'tiny-ctx' }] },
        '/api/show:tiny-ctx': {
          capabilities: ['tools'],
          model_info: { 'tinymodel.context_length': 100 },
        },
      })(url, init);
    });
    const p = getProvider('ollama');
    await expect(
      p.runAudit({
        credential: { baseUrl: 'http://box:11434' },
        model: 'tiny-ctx',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    ).rejects.toMatchObject({ variant: LLMError.ModelNotAvailable });
    expect(chatCalled).toBe(false);
  });
});
