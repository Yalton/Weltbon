/**
 * Issue #48 Task 5 — Ollama wire translation, split from `ollama.ts` so the
 * tool-shape and `num_ctx` logic are unit-testable without a server (see
 * the plan's file header note on why this split exists).
 *
 * `fromOllamaToolCalls` and `chooseNumCtx` were both written first from
 * Ollama's documented `/api/chat` shape, then corrected against ONE real
 * captured response from a live 0.32.12 server (`qwen3:14b`, saved at
 * `tests/fixtures/ollama/chat-tool-call.json`). The fixture overturned one
 * assumption baked into the original plan:
 *
 *   `tool_calls[0].id` EXISTS on a live server (`"call_a9wwonwx"` in the
 *   fixture) — the plan's "Ollama supplies no call id, a positional id is
 *   sufficient" was wrong. `fromOllamaToolCalls` therefore prefers the real
 *   id and only synthesizes a positional one when the field is genuinely
 *   absent. Using a synthesized id when a real one exists would risk
 *   mis-pairing a later `tool_result` message across a multi-turn audit run
 *   — the id is how the engine matches a result back to the call it answers.
 *
 * The fixture also confirmed `function.arguments` is a JSON object (not a
 * string) on Ollama. The string-accepting branch below is kept anyway:
 * OpenAI's identical-looking field IS a JSON string, so the shape is
 * genuinely provider-dependent, and accepting both costs nothing while
 * guarding against a future Ollama version switching representations.
 */
import { LLMError, LLMProviderError } from './interface.js';

export interface OllamaTool {
  type: 'function';
  function: { name: string; description: string; parameters: unknown };
}

/** Headroom over the estimated prompt so the model has room to answer. */
const OUTPUT_HEADROOM_TOKENS = 2048;
/** Used only when `/api/show` reported no architectural maximum (Task 4's `contextLength: null`). */
const CONSERVATIVE_MAX = 8192;

/** Engine tool shape (`{ name, description, input_schema }`) -> Ollama's `{ type, function }` shape. */
export function toOllamaTools(engineTools: unknown[]): OllamaTool[] {
  return engineTools.map((t) => {
    const tool = t as { name: string; description: string; input_schema: unknown };
    return {
      type: 'function',
      function: { name: tool.name, description: tool.description, parameters: tool.input_schema },
    };
  });
}

export function fromOllamaToolCalls(
  message: unknown,
): Array<{ id: string; name: string; input: Record<string, unknown> }> {
  const m = message as {
    tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: unknown } }>;
  };
  const calls = m?.tool_calls ?? [];
  return calls.flatMap((call, i) => {
    const name = call.function?.name;
    if (typeof name !== 'string') return [];
    const raw = call.function?.arguments;
    // Ollama returns an object; OpenAI returns a JSON string (see file
    // header). Accept both so a future Ollama change to string arguments
    // does not silently yield {}.
    let input: Record<string, unknown> = {};
    if (typeof raw === 'string') {
      try {
        input = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        throw new LLMProviderError(
          LLMError.UnknownProviderError,
          `Ollama returned unparseable arguments for tool ${name}`,
        );
      }
    } else if (raw !== null && typeof raw === 'object') {
      input = raw as Record<string, unknown>;
    }
    // Real id when present (see file header — this is the corrected
    // behavior); a positional fallback only covers the case where a server
    // genuinely omits it, so this never throws over a missing id.
    const id = typeof call.id === 'string' && call.id !== '' ? call.id : `ollama-${i}`;
    return [{ id, name, input }];
  });
}

export function chooseNumCtx(
  estimatedPromptTokens: number,
  architecturalMax: number | null,
): number {
  const needed = estimatedPromptTokens + OUTPUT_HEADROOM_TOKENS;
  const ceiling = architecturalMax ?? CONSERVATIVE_MAX;
  if (needed > ceiling) {
    throw new LLMProviderError(
      LLMError.ContextTruncated,
      `this audit needs about ${needed} tokens of context but the model supports at most ${ceiling}. ` +
        `Choose a model with a larger context window, or audit a smaller scope.`,
    );
  }
  return needed;
}
