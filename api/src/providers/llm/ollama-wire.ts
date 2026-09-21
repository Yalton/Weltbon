import { LLMError, LLMProviderError } from './interface.js';

export interface OllamaTool {
  type: 'function';
  function: { name: string; description: string; parameters: unknown };
}

const OUTPUT_HEADROOM_TOKENS = 2048;
const CONSERVATIVE_MAX = 8192;

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
