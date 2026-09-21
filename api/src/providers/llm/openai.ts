
import OpenAI from 'openai';
import { getEncoding } from 'js-tiktoken';
import type {
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from 'openai/resources/chat/completions';

import {
  LLMError,
  LLMProviderError,
  type LLMProvider,
  type ModelListing,
  type NormalizedUsage,
  type ProviderCredential,
  type RunAuditOpts,
  type RunAuditResult,
} from './interface.js';
import { PRICING, type OpenAIModelPricing } from './pricing.js';


const defaultModel = 'gpt-5-mini';


function estimateTokensLocal(
  messages: Array<{ role: string; content: string }>,
): number {
  const enc = getEncoding('o200k_base');
  try {
    let count = 0;
    for (const msg of messages) {
      count += 4; // per-message overhead (role + delimiters)
      count += enc.encode(msg.content).length;
    }
    count += 2; // reply priming tokens
    return count;
  } finally {
    (enc as { free?: () => void }).free?.();
  }
}


function mapOpenAIError(err: unknown): LLMProviderError {
  if (err instanceof OpenAI.AuthenticationError) {
    return new LLMProviderError(LLMError.InvalidApiKey, 'OpenAI rejected the API key');
  }
  if (err instanceof OpenAI.PermissionDeniedError) {
    return new LLMProviderError(
      LLMError.InvalidApiKey,
      'OpenAI API key lacks required permissions',
    );
  }
  if (err instanceof OpenAI.RateLimitError) {
    return new LLMProviderError(LLMError.RateLimited, 'OpenAI rate limit exceeded');
  }
  if (err instanceof OpenAI.APIConnectionError) {
    return new LLMProviderError(LLMError.NetworkError, 'OpenAI network error — try again');
  }
  if (err instanceof OpenAI.InternalServerError) {
    return new LLMProviderError(
      LLMError.NetworkError,
      'OpenAI server error — try again in a moment',
    );
  }
  if (err instanceof OpenAI.NotFoundError) {
    return new LLMProviderError(LLMError.ModelNotAvailable, 'OpenAI model not found');
  }
  if (err instanceof OpenAI.UnprocessableEntityError) {
    return new LLMProviderError(
      LLMError.ModelNotAvailable,
      'OpenAI cannot process request with this model',
    );
  }
  if (err instanceof OpenAI.APIError) {
    if (err.status === 402) {
      return new LLMProviderError(
        LLMError.InsufficientCredits,
        'OpenAI account is out of credits',
      );
    }
  }
  if (err instanceof OpenAI.BadRequestError) {
    return new LLMProviderError(
      LLMError.UnknownProviderError,
      'Unexpected OpenAI bad-request — see server log',
    );
  }
  return new LLMProviderError(LLMError.UnknownProviderError, 'Unknown OpenAI error');
}


function computeOpenAICost(
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    prompt_tokens_details?: { cached_tokens?: number };
  },
  pricing: OpenAIModelPricing,
): number {
  const cachedTokens = usage.prompt_tokens_details?.cached_tokens ?? 0;
  const regularInput =
    ((usage.prompt_tokens - cachedTokens) * pricing.inputUsdPer1M) / 1_000_000;
  const cachedInput = (cachedTokens * pricing.cachedInputUsdPer1M) / 1_000_000;
  const output = (usage.completion_tokens * pricing.outputUsdPer1M) / 1_000_000;
  return regularInput + cachedInput + output;
}


function normalizeUsage(usage: {
  prompt_tokens: number;
  completion_tokens: number;
  prompt_tokens_details?: { cached_tokens?: number };
}): NormalizedUsage {
  return {
    inputTokens: usage.prompt_tokens,
    outputTokens: usage.completion_tokens,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: usage.prompt_tokens_details?.cached_tokens ?? 0,
  };
}


export class OpenAIProvider implements LLMProvider {
  async validate(credential: ProviderCredential): Promise<void> {
    const apiKey = credential.apiKey;
    if (apiKey === undefined) {
      throw new LLMProviderError(LLMError.InvalidApiKey, 'no api key supplied');
    }
    const client = new OpenAI({ apiKey });
    try {
      await client.models.list();
    } catch (err) {
      throw mapOpenAIError(err);
    }
  }

  async estimate(opts: {
    credential: ProviderCredential;
    messages: RunAuditOpts['messages'];
    model?: string;
    system?: string;
  }): Promise<number> {
    const messages: Array<{ role: string; content: string }> =
      opts.system !== undefined
        ? [{ role: 'system', content: opts.system }, ...opts.messages]
        : [...opts.messages];
    return Promise.resolve(estimateTokensLocal(messages));
  }

  async runAudit(opts: RunAuditOpts): Promise<RunAuditResult> {
    const apiKey = opts.credential.apiKey;
    if (apiKey === undefined) {
      throw new LLMProviderError(LLMError.InvalidApiKey, 'no api key supplied');
    }
    const model = opts.model ?? defaultModel;
    const pricing = (PRICING.openai as Record<string, OpenAIModelPricing>)[model];

    const openaiTools: ChatCompletionTool[] | undefined =
      opts.tools && opts.tools.length > 0
        ? opts.tools.map((t) => {
            const engineTool = t as {
              name: string;
              description: string;
              input_schema: Record<string, unknown>;
            };
            return {
              type: 'function' as const,
              function: {
                name: engineTool.name,
                description: engineTool.description,
                parameters: engineTool.input_schema,
              },
            };
          })
        : undefined;

    const client = new OpenAI({ apiKey });
    let completion;
    try {
      completion = await client.chat.completions.create({
        model,
        messages: opts.messages as ChatCompletionMessageParam[],
        ...(openaiTools ? { tools: openaiTools } : {}),
      });
    } catch (err) {
      throw mapOpenAIError(err);
    }

    const choice = completion.choices[0];
    if (!choice) {
      throw new LLMProviderError(
        LLMError.UnknownProviderError,
        'OpenAI returned no choices',
      );
    }

    if (choice.finish_reason === 'content_filter') {
      throw new LLMProviderError(
        LLMError.ContentBlockedBySafetyFilter,
        'OpenAI content filter blocked the response',
      );
    }
    if (choice.message.refusal) {
      throw new LLMProviderError(
        LLMError.ContentBlockedBySafetyFilter,
        'OpenAI refused to generate content',
      );
    }
    if (choice.finish_reason === 'length') {
      throw new LLMProviderError(
        LLMError.UnknownProviderError,
        'OpenAI response truncated by token limit — output is incomplete',
      );
    }

    const toolCalls = choice.message.tool_calls ?? [];
    const toolUse: RunAuditResult['toolUse'] = toolCalls
      .filter((tc): tc is Extract<typeof tc, { type: 'function' }> => tc.type === 'function')
      .map((tc) => {
        let parsedArgs: Record<string, unknown>;
        try {
          parsedArgs = JSON.parse(tc.function.arguments) as Record<string, unknown>;
        } catch (err) {
          throw new LLMProviderError(
            LLMError.UnknownProviderError,
            `OpenAI tool_call arguments are not valid JSON (function=${tc.function.name})`,
          );
        }
        return {
          id: tc.id,
          name: tc.function.name,
          input: parsedArgs,
        };
      });

    const text = choice.message.content ?? '';

    if (!completion.usage) {
      throw new LLMProviderError(
        LLMError.UnknownProviderError,
        'OpenAI response missing usage',
      );
    }

    const costUsd = pricing !== undefined ? computeOpenAICost(completion.usage, pricing) : 0;

    return {
      text,
      toolUse,
      usage: normalizeUsage(completion.usage),
      costUsd,
    };
  }

  listModels(): ModelListing[] {
    return Object.keys(PRICING.openai).map((id) => {
      const row = PRICING.openai[id as keyof typeof PRICING.openai];
      return {
        id,
        inputUsdPer1M: row.inputUsdPer1M,
        outputUsdPer1M: row.outputUsdPer1M,
        cachedInputUsdPer1M: row.cachedInputUsdPer1M,
      };
    });
  }

  pricing(model: string): ModelListing | undefined {
    const row = (PRICING.openai as Record<string, OpenAIModelPricing>)[model];
    if (!row) return undefined;
    return {
      id: model,
      inputUsdPer1M: row.inputUsdPer1M,
      outputUsdPer1M: row.outputUsdPer1M,
      cachedInputUsdPer1M: row.cachedInputUsdPer1M,
    };
  }
}
