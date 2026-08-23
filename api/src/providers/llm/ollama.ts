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
import { toOllamaTools, fromOllamaToolCalls, chooseNumCtx } from './ollama-wire.js';

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
 * Takes the whole `ProviderCredential`, not a bare base URL. Fix round 2 (#48
 * whole-branch review, Important 3): it used to take only the URL and send no
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

/**
 * Multiplier applied to `estimate()`'s chars/4 output BEFORE it is handed to
 * `chooseNumCtx` — sizing input only, never the estimate itself.
 *
 * Why this exists (fix round 2, #48 whole-branch review, Critical 2): the real
 * audit prompt is the structural digest, and `services/structural-digest.ts`
 * serializes every entry UUID THREE times (the entry rows, the link tuples,
 * and `validEntryIds`). A UUID does not tokenize at 4 chars/token — measured
 * with js-tiktoken's `o200k_base`, a single UUID is 36 chars and 21 tokens,
 * i.e. ~1.7 chars/token. On a digest-shaped payload (200 entries / 300 links /
 * 50 pins) the whole-document ratio comes out at:
 *
 *     chars 76,269 | heuristic (chars/4) 19,068 | actual 33,726 | ratio 1.77x
 *
 * (The review that found this measured 1.66x on a slightly different content
 * mix; the factor below covers both, with a little margin, rather than being
 * tuned to one sample.)
 *
 * What the undercount cost: `chooseNumCtx` sized a ~35k-token prompt at ~23k,
 * and Ollama then dropped ~12k tokens off the FRONT — the `role:'system'`
 * message carrying the digest — silently. The audit returned normal-looking
 * findings computed against part of the universe, which is precisely the
 * failure D-4 exists to make impossible, arrived at THROUGH the guard meant to
 * prevent it. It also deferred the loud refusal when a prompt genuinely
 * exceeds the architectural maximum.
 *
 * Being wrong high costs a larger KV cache on the user's own box, and (at the
 * extreme) a spurious pre-run refusal for a prompt that would in fact have
 * fit. Being wrong low used to cost a quietly partial audit — no longer, since
 * the post-response `prompt_eval_count` check in `runAudit` now turns any
 * remaining undercount into a loud failure rather than a silent one.
 *
 * NOT folded into `estimate()`: that method's contract is documented as
 * messages-only and feeds the pre-run cost UI for every provider path, so a
 * change there has a blast radius well beyond this one call site.
 */
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

  /**
   * Single-turn wire adapter (D-01) against `/api/chat`.
   *
   * Two things this method must always do, both load-bearing:
   *
   *   1. Re-check tool-capability at run time via `listOllamaModels`, not
   *      just trust the model name string. Local models get deleted /
   *      re-pulled outside this app's control, so a model valid at
   *      selection time may be gone or replaced (by a same-named but
   *      differently-capable pull) by the time an audit actually runs.
   *
   *   2. Always set `options.num_ctx` explicitly via `chooseNumCtx`, never
   *      let the request omit it. Ollama's server-side default (commonly
   *      2048 or 4096 depending on version) has no relationship to what a
   *      given audit prompt needs; omitting it would silently truncate
   *      context on any prompt longer than that default with no error.
   */
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
    // Computed once, reused for both sizing (below) and the request body
    // (below that) — never estimate from `opts.tools` and serialize a
    // separately-derived shape, or the two could drift.
    const wireTools = opts.tools ? toOllamaTools(opts.tools) : undefined;
    // `estimate()` (above) counts only `messages` + `system`, per its
    // documented contract for the pre-run cost UI — it does NOT count
    // `opts.tools`. But tool definitions ARE serialized onto the wire below
    // (a real audit's `emit_findings` schema, generated via `z.toJSONSchema`
    // in audit-engine.ts, is not small). Sizing `chooseNumCtx` from
    // `estimatedMessageTokens` alone would silently undercount, which
    // defeats the whole point of setting `num_ctx` explicitly (D-4: make
    // truncation impossible, not merely unlikely) — a model near its
    // ceiling could pass this check on the prompt alone and then still get
    // silently truncated once the tool schema is added on the wire. Added
    // here, at the sizing site, rather than widening `estimate()` itself:
    // `estimate()`'s contract is documented as messages-only and also feeds
    // the pre-run cost UI for every provider path, so widening it has a
    // blast radius beyond this one call site. If this local addition is
    // ever wrong (e.g. Ollama's tool wire format changes shape), the
    // failure mode is contained to Ollama's own num_ctx sizing rather than
    // corrupting the cost estimate other providers' UI reads too.
    const toolTokens = wireTools ? Math.ceil(JSON.stringify(wireTools).length / 4) : 0;
    // Throws ModelNotAvailable (before any /api/chat call) when the
    // estimated prompt cannot fit even the model's architectural maximum —
    // see ollama-wire.ts. `info.contextLength` is that architectural
    // maximum, NOT a runtime window (Task 4); num_ctx below is the only
    // place the runtime window is ever set.
    // PROMPT_TOKEN_SAFETY_FACTOR (see its definition) corrects the chars/4
    // heuristic for the UUID-dense digest this prompt actually is. Applied to
    // the sum: the tool schema is identifier-dense too, so the same
    // undercount applies to it.
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
        /**
         * qwen3-family "thinking" models put their prose reasoning HERE, not
         * in `content` — confirmed against a real captured response
         * (`tests/fixtures/ollama/chat-tool-call.json`: `content` is `''`
         * while `thinking` is 2095 chars). `text` below reads ONLY
         * `message.content`, deliberately — the audit engine treats
         * non-empty prose text in a final turn as a D-10 contract
         * violation, so surfacing `thinking` as `text` would falsely trip
         * that on every thinking-model response. Kept in this type (rather
         * than left untyped/dropped) purely so a future reader who logs
         * `body` locally while debugging can see the field is named and
         * intentionally unused, without this file ever needing to log the
         * user's audit content itself to make that visible.
         */
        thinking?: string;
      };
      prompt_eval_count?: number;
      eval_count?: number;
    };

    // The one check that makes D-4 actually impossible rather than merely
    // unlikely. Everything above is a PREDICTION of the prompt size; this is
    // the server telling us what it really tokenized. Ollama truncates a
    // prompt that exceeds num_ctx silently — no error, no flag, just an audit
    // performed against part of the universe — so a prompt_eval_count that
    // reaches the window we asked for is the only evidence available that it
    // happened. `>=` rather than `>`: a truncated prompt is clamped TO the
    // window, so equality is the truncation signature, not a coincidence. The
    // cost of the off-by-one going the other way (a genuine prompt landing
    // exactly on num_ctx and being refused) is a loud, actionable error on a
    // free local run; the cost of missing it is findings the user trusts and
    // shouldn't.
    const promptEvalCount = body.prompt_eval_count ?? 0;
    if (promptEvalCount >= numCtx) {
      throw new LLMProviderError(
        LLMError.ModelNotAvailable,
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
      // Always zero: Ollama is free, and the engine's cost_unknown path expects it.
      costUsd: 0,
    };
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
