/**
 * Issue #48 (Ollama as a local LLM provider) — Task 4: `OllamaProvider`.
 *
 * Ollama is endpoint-based, not key-based (per `ProviderCredential`, Task 3):
 * `credential.baseUrl` addresses the server, `credential.secret` is an
 * optional bearer for an authenticating reverse proxy in front of it (Ollama
 * itself has no auth). There is never an `llm_api_keys` row for this
 * provider — see `KEY_PROVIDER_NAMES` in `services/llm-key.ts`.
 *
 * Two facts measured against a live Ollama 0.32.12 server drive this file's
 * shape (fixtures under `tests/fixtures/ollama/`, captured — not hand-written
 * — so a wire-format change would break the fixture, not just this code):
 *
 *   1. Tool-calling support is reported by `/api/show`'s `capabilities`
 *      array containing `'tools'`. That is the ONLY gate — no probing a
 *      model by trying a tool call and seeing if it errors, no hand-maintained
 *      allowlist of "known good" model names that would silently go stale as
 *      new models are pulled.
 *
 *   2. `model_info["<arch>.context_length"]` (the key is architecture-
 *      prefixed — `qwen3.context_length`, `llama.context_length`, etc., so it
 *      is located by suffix match, not a fixed key) is the model's
 *      ARCHITECTURAL maximum context, not the window any particular run will
 *      actually get. The runtime window is `num_ctx`, which a later task
 *      (audit turns) always sets explicitly on the request. Do not feed
 *      `contextLength` to anything as if it were the effective window — see
 *      the "NOT the runtime window" test, which pins this deliberately.
 *
 * Discovery (`listOllamaModels`) is N+1 by design: one `/api/tags` call for
 * the installed-model list, then one `/api/show` per model for capabilities
 * and context length (tags does not carry `model_info`). For the handful of
 * models a single box hosts this is fine; there is no pagination or batching
 * concern here the way there would be against a multi-tenant hosted API.
 */

import {
  LLMError,
  LLMProviderError,
  type LLMProvider,
  type ModelListing,
  type ProviderCredential,
  type RunAuditOpts,
  type RunAuditResult,
} from './interface.js';

export interface OllamaModelInfo {
  name: string;
  supportsTools: boolean;
  /** The model's ARCHITECTURAL maximum. NOT the runtime window — see file header. */
  contextLength: number | null;
}

/**
 * `credential.baseUrl` is required for every Ollama call — there is no
 * fallback default endpoint, because guessing one (e.g. localhost:11434)
 * would silently point a hosted-server deployment at the wrong machine.
 * Checked before any network I/O so a misconfigured connection fails fast
 * with a message that names the problem, not a DNS error three lines later.
 */
function requireBaseUrl(credential: ProviderCredential): string {
  const baseUrl = credential.baseUrl;
  if (baseUrl === undefined || baseUrl === '') {
    throw new LLMProviderError(LLMError.InvalidApiKey, 'no Ollama base URL configured');
  }
  return baseUrl.replace(/\/+$/, '');
}

/** Ollama itself has no auth; `secret` only matters when a proxy sits in front of it. */
function headers(credential: ProviderCredential): Record<string, string> {
  const h: Record<string, string> = { 'Content-Type': 'application/json' };
  if (credential.secret) h.Authorization = `Bearer ${credential.secret}`;
  return h;
}

async function callOllama(
  url: string,
  init: RequestInit,
  fetchImpl: typeof fetch,
): Promise<Response> {
  try {
    return await fetchImpl(url, init);
  } catch (err) {
    // Connection refused, DNS failure and timeouts all arrive as a rejected
    // promise, never a status code — `fetch` never throws for a non-2xx
    // response, only for a request that could not be made at all. That is
    // exactly the "server unreachable" case this maps to NetworkError, kept
    // distinct from InvalidApiKey (Ollama has no key to be invalid).
    throw new LLMProviderError(
      LLMError.NetworkError,
      `could not reach Ollama at ${url}: ${(err as Error).name}`,
    );
  }
}

/**
 * List installed models with tool-capability and context-length metadata.
 *
 * `fetchImpl` defaults to the global `fetch` but is overridable so tests
 * never touch a real network (see `tests/llm-ollama.test.ts`'s `fakeFetch`).
 */
export async function listOllamaModels(
  baseUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<OllamaModelInfo[]> {
  const root = baseUrl.replace(/\/+$/, '');
  const tagsRes = await callOllama(`${root}/api/tags`, { method: 'GET' }, fetchImpl);
  if (!tagsRes.ok) {
    throw new LLMProviderError(LLMError.NetworkError, `Ollama /api/tags returned ${tagsRes.status}`);
  }
  const tags = (await tagsRes.json()) as { models?: Array<{ name?: string }> };
  const names = (tags.models ?? []).map((m) => m.name).filter((n): n is string => Boolean(n));

  const out: OllamaModelInfo[] = [];
  for (const name of names) {
    const showRes = await callOllama(
      `${root}/api/show`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: name }) },
      fetchImpl,
    );
    if (!showRes.ok) {
      // A model can be listed in /api/tags and then removed (or fail to
      // load, e.g. corrupt blob) before /api/show is reached. Rather than
      // aborting the whole listing over one bad model, report it as
      // tool-incapable with unknown context length — safe defaults that
      // exclude it from tool-using flows without hiding it from the list.
      out.push({ name, supportsTools: false, contextLength: null });
      continue;
    }
    const show = (await showRes.json()) as {
      capabilities?: string[];
      model_info?: Record<string, unknown>;
    };
    // The context-length key is architecture-prefixed (`qwen3.context_length`,
    // `llama.context_length`, ...) so it is found by suffix match rather than
    // a fixed key name.
    const ctxEntry = Object.entries(show.model_info ?? {}).find(([k]) =>
      k.endsWith('.context_length'),
    );
    out.push({
      name,
      supportsTools: (show.capabilities ?? []).includes('tools'),
      contextLength: typeof ctxEntry?.[1] === 'number' ? ctxEntry[1] : null,
    });
  }
  return out;
}

export class OllamaProvider implements LLMProvider {
  /**
   * Cheapest available reachability + liveness check: `GET /api/tags`. There
   * is no credential to be "invalid" the way an API key can be — a
   * misconfigured/unreachable endpoint is always NetworkError, never
   * InvalidApiKey (pinned by the "not InvalidApiKey" test).
   */
  async validate(credential: ProviderCredential): Promise<void> {
    const baseUrl = requireBaseUrl(credential);
    const res = await callOllama(`${baseUrl}/api/tags`, { method: 'GET', headers: headers(credential) }, fetch);
    if (!res.ok) {
      throw new LLMProviderError(LLMError.NetworkError, `Ollama returned ${res.status}`);
    }
  }

  async estimate(opts: {
    credential: ProviderCredential;
    messages: RunAuditOpts['messages'];
    model?: string;
    system?: string;
  }): Promise<number> {
    // Ollama exposes no free token counter (no equivalent of Anthropic's
    // countTokens() or an offline tiktoken-style encoder tied to arbitrary
    // local model vocabularies). This feeds only the pre-run cost UI, where
    // the cost is zero regardless of the estimate's accuracy, so a character
    // heuristic is sufficient — and per PROVIDER-07 it must stay local, so a
    // network round-trip to ask the server to estimate is not an option.
    const chars =
      (opts.system?.length ?? 0) + opts.messages.reduce((n, m) => n + m.content.length, 0);
    return Math.ceil(chars / 4);
  }

  async runAudit(_opts: RunAuditOpts): Promise<RunAuditResult> {
    throw new Error('implemented in Task 5');
  }

  /**
   * Empty by contract: `listModels()` is documented (interface.ts) as
   * offline and PRICING-derived, and Ollama has no PRICING entries (it is
   * free / local). Returning `[]` rather than throwing keeps every call site
   * that iterates `listModels()` working unchanged.
   */
  listModels(): ModelListing[] {
    return [];
  }

  /** Always undefined — Ollama is free, so the engine takes its cost_unknown path. */
  pricing(_model: string): ModelListing | undefined {
    return undefined;
  }
}
