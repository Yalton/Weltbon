import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const fx = (n: string) => JSON.parse(readFileSync(resolve(here, `fixtures/ollama/${n}.json`), 'utf8'));

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
