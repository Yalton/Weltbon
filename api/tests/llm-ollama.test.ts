import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const fx = (n: string) => JSON.parse(readFileSync(resolve(here, `fixtures/ollama/${n}.json`), 'utf8'));

function fakeFetch(routes: Record<string, unknown>) {
  return async (url: string): Promise<Response> => {
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
        '/api/show': fx('show-qwen3-32b'),
      }) as unknown as typeof fetch,
    );
    const q = models.find((m) => m.name === 'qwen3:32b');
    expect(q?.supportsTools).toBe(true);
  });

  it('reports the architectural context length, which is NOT the runtime window', async () => {
    // Recorded so nobody later "fixes" this by feeding it to num_ctx: the
    // runtime window is num_ctx, which we always set ourselves (spec D-4).
    const { listOllamaModels } = await import('../src/providers/llm/ollama.js');
    const models = await listOllamaModels(
      'http://box:11434',
      fakeFetch({
        '/api/tags': { models: [{ name: 'qwen3:32b' }] },
        '/api/show': fx('show-qwen3-32b'),
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
    const p = getProvider('ollama');
    await expect(p.validate({})).rejects.toThrow();
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
