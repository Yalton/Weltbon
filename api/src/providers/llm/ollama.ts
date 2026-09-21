/**
 *
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
import { toOllamaTools, fromOllamaToolCalls, chooseNumCtx } from './ollama-wire.js';

export interface OllamaModelInfo {
  name: string;
  supportsTools: boolean;
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
    // promise, never a status code — `fetch` never throws for a non-2xx
    throw new LLMProviderError(
      LLMError.NetworkError,
      `could not reach Ollama at ${url}: ${(err as Error).name}`,
    );
  }
}

/**
 * List installed models with tool-capability and context-length metadata.
 *
 * `Authorization` header, while `validate()` below sent one. For a user whose
 * Ollama sits behind an authenticating reverse proxy, that split the feature
 * in half in the most misleading way available: "Save and test" validated WITH
 * the bearer and lit up a green "Reachable", and then every model listing
 * 401'd — an empty dropdown, plus `runAudit`'s run-time capability re-check
 * failing against the same 401. A success indicator sitting downstream of a
 * different request than the one that fails is worse than no indicator.
 *
 * `fetchImpl` defaults to the global `fetch` but is overridable so tests
 * never touch a real network (see `tests/llm-ollama.test.ts`'s `fakeFetch`).
 */
export async function listOllamaModels(
  credential: ProviderCredential,
  fetchImpl: typeof fetch = fetch,
): Promise<OllamaModelInfo[]> {
  const root = requireBaseUrl(credential);
  const tagsRes = await callOllama(
    `${root}/api/tags`,
    { method: 'GET', headers: headers(credential) },
    fetchImpl,
  );
  if (!tagsRes.ok) {
    throw new LLMProviderError(LLMError.NetworkError, `Ollama /api/tags returned ${tagsRes.status}`);
  }
  const tags = (await tagsRes.json()) as { models?: Array<{ name?: string }> };
  const names = (tags.models ?? []).map((m) => m.name).filter((n): n is string => Boolean(n));

  const out: OllamaModelInfo[] = [];
  for (const name of names) {
    const showRes = await callOllama(
      `${root}/api/show`,
      { method: 'POST', headers: headers(credential), body: JSON.stringify({ model: name }) },
      fetchImpl,
    );
    if (!showRes.ok) {
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

const PROMPT_TOKEN_SAFETY_FACTOR = 1.8;

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
    // countTokens() or an offline tiktoken-style encoder tied to arbitrary
    // local model vocabularies). This feeds only the pre-run cost UI, where
    // heuristic is sufficient — and per PROVIDER-07 it must stay local, so a
    // network round-trip to ask the server to estimate is not an option.
    const chars =
      (opts.system?.length ?? 0) + opts.messages.reduce((n, m) => n + m.content.length, 0);
    return Math.ceil(chars / 4);
  }

  async runAudit(opts: RunAuditOpts): Promise<RunAuditResult> {
    const baseUrl = requireBaseUrl(opts.credential);
    const model = opts.model;
    if (model === undefined) {
      throw new LLMProviderError(LLMError.ModelNotAvailable, 'no Ollama model selected');
    }

    const models = await listOllamaModels(opts.credential);
    const info = models.find((m) => m.name === model);
    if (info === undefined) {
      throw new LLMProviderError(
        LLMError.ModelNotAvailable,
        `model ${model} is no longer installed on this Ollama server`,
      );
    }
    if (!info.supportsTools) {
      throw new LLMProviderError(
        LLMError.ModelNotAvailable,
        `model ${model} does not support tool calling, which audits require`,
      );
    }

    const estimatedMessageTokens = await this.estimate({
      credential: opts.credential,
      messages: opts.messages,
      model,
    });
    // separately-derived shape, or the two could drift.
    const wireTools = opts.tools ? toOllamaTools(opts.tools) : undefined;
    // documented contract for the pre-run cost UI — it does NOT count
    // in audit-engine.ts, is not small). Sizing `chooseNumCtx` from
    // defeats the whole point of setting `num_ctx` explicitly (D-4: make
    // `estimate()`'s contract is documented as messages-only and also feeds
    // the pre-run cost UI for every provider path, so widening it has a
    const toolTokens = wireTools ? Math.ceil(JSON.stringify(wireTools).length / 4) : 0;
    // see ollama-wire.ts. `info.contextLength` is that architectural
    // heuristic for the UUID-dense digest this prompt actually is. Applied to
    // the sum: the tool schema is identifier-dense too, so the same
    const sizingTokens = Math.ceil(
      (estimatedMessageTokens + toolTokens) * PROMPT_TOKEN_SAFETY_FACTOR,
    );
    const numCtx = chooseNumCtx(sizingTokens, info.contextLength);

    const res = await callOllama(
      `${baseUrl}/api/chat`,
      {
        method: 'POST',
        headers: headers(opts.credential),
        body: JSON.stringify({
          model,
          stream: false,
          options: { num_ctx: numCtx, temperature: 0 },
          messages: opts.messages,
          tools: wireTools,
        }),
      },
      fetch,
    );
    if (!res.ok) {
      throw new LLMProviderError(LLMError.NetworkError, `Ollama /api/chat returned ${res.status}`);
    }

    const body = (await res.json()) as {
      message?: {
        content?: string;
        thinking?: string;
      };
      prompt_eval_count?: number;
      eval_count?: number;
    };

    // The one check that makes D-4 actually impossible rather than merely
    // cost of the off-by-one going the other way (a genuine prompt landing
    const promptEvalCount = body.prompt_eval_count ?? 0;
    if (promptEvalCount >= numCtx) {
      throw new LLMProviderError(
        LLMError.ContextTruncated,
        `Ollama tokenized ${promptEvalCount} prompt tokens into a ${numCtx}-token context window, ` +
          `so part of this audit's prompt was dropped and the findings would cover only part of ` +
          `your universe. Audit a smaller scope, or choose a model with a larger context window.`,
      );
    }

    return {
      text: body.message?.content ?? '',
      toolUse: fromOllamaToolCalls(body.message),
      usage: {
        inputTokens: body.prompt_eval_count ?? 0,
        outputTokens: body.eval_count ?? 0,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
      },
      costUsd: 0,
    };
  }

  listModels(): ModelListing[] {
    return [];
  }

  pricing(_model: string): ModelListing | undefined {
    return undefined;
  }
}
