
import Anthropic from '@anthropic-ai/sdk';
import type {
  MessageParam,
  MessageCreateParams,
  Tool,
  ToolUseBlock,
  TextBlock,
  Usage,
} from '@anthropic-ai/sdk/resources/messages';

import {
  LLMError,
  LLMProviderError,
  MIN_CACHEABLE_TOKENS,
  type LLMProvider,
  type ModelListing,
  type NormalizedUsage,
  type ProviderCredential,
  type RunAuditOpts,
  type RunAuditResult,
} from './interface.js';
import { PRICING, type AnthropicModelPricing } from './pricing.js';


const defaultModel = 'claude-haiku-4-5-20251001';


type EngineMsg = { role: 'system' | 'user' | 'assistant' | 'tool'; content: string };

function toAnthropicMessages(msgs: EngineMsg[]): MessageParam[] {
  const out: MessageParam[] = [];
  let pendingToolResults: Array<{
    type: 'tool_result';
    tool_use_id: string;
    content: string;
  }> = [];

  const flushPendingToolResults = (): void => {
    if (pendingToolResults.length === 0) return;
    out.push({ role: 'user', content: pendingToolResults });
    pendingToolResults = [];
  };

  for (const m of msgs) {
    if (m.role === 'system') {
      continue;
    }

    if (m.role === 'tool') {
      let envelope: { tool_call_id?: string; content?: string };
      try {
        envelope = JSON.parse(m.content) as typeof envelope;
      } catch {
        flushPendingToolResults();
        out.push({ role: 'user', content: m.content });
        continue;
      }
      pendingToolResults.push({
        type: 'tool_result',
        tool_use_id: envelope.tool_call_id ?? '',
        content: envelope.content ?? '',
      });
      continue;
    }

    flushPendingToolResults();

    if (m.role === 'assistant') {
      let toolUseBlocks: Array<{
        type: 'tool_use';
        id: string;
        name: string;
        input: Record<string, unknown>;
      }> | null = null;
      try {
        const parsed = JSON.parse(m.content);
        if (
          Array.isArray(parsed) &&
          parsed.length > 0 &&
          typeof parsed[0] === 'object' &&
          parsed[0] !== null &&
          'name' in parsed[0] &&
          'id' in parsed[0]
        ) {
          toolUseBlocks = (parsed as Array<{
            id: string;
            name: string;
            input: Record<string, unknown>;
          }>).map((tu) => ({
            type: 'tool_use',
            id: tu.id,
            name: tu.name,
            input: tu.input,
          }));
        }
      } catch {
      }
      if (toolUseBlocks) {
        out.push({ role: 'assistant', content: toolUseBlocks });
      } else {
        out.push({ role: 'assistant', content: m.content });
      }
      continue;
    }

    out.push({ role: 'user', content: m.content });
  }

  flushPendingToolResults();
  return out;
}

const ANTHROPIC_MAX_TOKENS = 4096;


function mapAnthropicError(err: unknown): LLMProviderError {
  if (err instanceof Anthropic.AuthenticationError) {
    return new LLMProviderError(LLMError.InvalidApiKey, 'Anthropic rejected the API key');
  }
  if (err instanceof Anthropic.PermissionDeniedError) {
    return new LLMProviderError(
      LLMError.InvalidApiKey,
      'Anthropic API key lacks required permissions',
    );
  }
  if (err instanceof Anthropic.RateLimitError) {
    return new LLMProviderError(LLMError.RateLimited, 'Anthropic rate limit exceeded');
  }
  if (err instanceof Anthropic.APIConnectionTimeoutError) {
    return new LLMProviderError(
      LLMError.NetworkError,
      'Anthropic request timed out — try again',
    );
  }
  if (err instanceof Anthropic.APIConnectionError) {
    return new LLMProviderError(
      LLMError.NetworkError,
      'Anthropic network error — try again in a moment',
    );
  }
  if (err instanceof Anthropic.InternalServerError) {
    return new LLMProviderError(
      LLMError.NetworkError,
      'Anthropic server error — try again in a moment',
    );
  }
  if (err instanceof Anthropic.APIError) {
    if (err.status === 402) {
      return new LLMProviderError(
        LLMError.InsufficientCredits,
        'Anthropic account is out of credits',
      );
    }
    if (err.status === 529) {
      return new LLMProviderError(
        LLMError.NetworkError,
        'Anthropic overloaded — try again in a moment',
      );
    }
    if (err.status === 404 || err.status === 422) {
      return new LLMProviderError(
        LLMError.ModelNotAvailable,
        'Anthropic model not available',
      );
    }
  }
  if (err instanceof Anthropic.BadRequestError) {
    console.error(
      '[anthropic] BadRequestError:',
      err.status,
      err.message,
    );
    return new LLMProviderError(
      LLMError.UnknownProviderError,
      'Unexpected Anthropic bad-request — see server log',
    );
  }
  console.error(
    '[anthropic] unmapped error:',
    (err instanceof Error ? `${err.constructor.name}: ${err.message}` : String(err)),
  );
  return new LLMProviderError(LLMError.UnknownProviderError, 'Unknown Anthropic error');
}


function computeAnthropicCost(usage: Usage, pricing: AnthropicModelPricing): number {
  const cacheCreate = usage.cache_creation_input_tokens ?? 0;
  const cacheRead = usage.cache_read_input_tokens ?? 0;
  const regularInput = (usage.input_tokens * pricing.inputUsdPer1M) / 1_000_000;
  const cacheWrite = (cacheCreate * pricing.cacheWriteUsdPer1M) / 1_000_000;
  const cacheReadCost = (cacheRead * pricing.cachedInputUsdPer1M) / 1_000_000;
  const output = (usage.output_tokens * pricing.outputUsdPer1M) / 1_000_000;
  return regularInput + cacheWrite + cacheReadCost + output;
}


function normalizeUsage(usage: Usage): NormalizedUsage {
  return {
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    cacheCreationInputTokens: usage.cache_creation_input_tokens ?? 0,
    cacheReadInputTokens: usage.cache_read_input_tokens ?? 0,
  };
}


export class AnthropicProvider implements LLMProvider {
  async validate(credential: ProviderCredential): Promise<void> {
    const apiKey = credential.apiKey;
    if (apiKey === undefined) {
      throw new LLMProviderError(LLMError.InvalidApiKey, 'no api key supplied');
    }
    const client = new Anthropic({ apiKey });
    try {
      await client.messages.countTokens({
        model: defaultModel,
        messages: [{ role: 'user', content: 'hi' }],
      });
    } catch (err) {
      throw mapAnthropicError(err);
    }
  }

  async estimate(opts: {
    credential: ProviderCredential;
    messages: RunAuditOpts['messages'];
    model?: string;
    system?: string;
  }): Promise<number> {
    const apiKey = opts.credential.apiKey;
    if (apiKey === undefined) {
      throw new LLMProviderError(LLMError.InvalidApiKey, 'no api key supplied');
    }
    const client = new Anthropic({ apiKey });

    const firstMsg = opts.messages[0];
    const hasLeadingSystem = firstMsg?.role === 'system';
    const nonSystemMessages = (hasLeadingSystem ? opts.messages.slice(1) : opts.messages)
      .filter((m): m is Exclude<typeof m, { role: 'system' }> => m.role !== 'system');
    const conversationMessages: MessageParam[] = nonSystemMessages.map((m) => ({
      role: m.role as MessageParam['role'],
      content: m.content,
    }));

    const effectiveSystem: string | undefined =
      opts.system ?? (hasLeadingSystem ? firstMsg!.content : undefined);

    try {
      const res = await client.messages.countTokens({
        model: opts.model ?? defaultModel,
        messages: conversationMessages,
        ...(effectiveSystem !== undefined ? { system: effectiveSystem } : {}),
      });
      return res.input_tokens;
    } catch (err) {
      throw mapAnthropicError(err);
    }
  }

  async runAudit(opts: RunAuditOpts): Promise<RunAuditResult> {
    const apiKey = opts.credential.apiKey;
    if (apiKey === undefined) {
      throw new LLMProviderError(LLMError.InvalidApiKey, 'no api key supplied');
    }
    const model = opts.model ?? defaultModel;
    const pricing = (PRICING.anthropic as Record<string, AnthropicModelPricing>)[model];

    const first = opts.messages[0];
    const hasLeadingSystem = first?.role === 'system';

    type SystemBlock = { type: 'text'; text: string; cache_control?: { type: 'ephemeral' } };
    let conversationMessages: RunAuditOpts['messages'];
    let extractedSystemText: string | undefined;

    if (hasLeadingSystem) {
      extractedSystemText = first.content;
      conversationMessages = opts.messages.slice(1);
    } else {
      extractedSystemText = undefined;
      conversationMessages = opts.messages;
    }

    const anthropicMessages = toAnthropicMessages(conversationMessages);

    let promptTokens: number;
    try {
      const countClient = new Anthropic({ apiKey });
      const countRes = await countClient.messages.countTokens({
        model,
        messages: anthropicMessages,
        ...(extractedSystemText !== undefined ? { system: extractedSystemText } : {}),
      });
      promptTokens = countRes.input_tokens;
    } catch (err) {
      throw mapAnthropicError(err);
    }
    const useCache = promptTokens >= MIN_CACHEABLE_TOKENS;

    let systemParam: SystemBlock[] | undefined;
    if (hasLeadingSystem && extractedSystemText !== undefined) {
      const block: SystemBlock = { type: 'text', text: extractedSystemText };
      if (useCache) {
        block.cache_control = { type: 'ephemeral' };
      }
      systemParam = [block];
    } else {
      systemParam = undefined;
    }

    const client = new Anthropic({ apiKey });
    let response;
    try {
      const createParams: MessageCreateParams = {
        model,
        max_tokens: ANTHROPIC_MAX_TOKENS,
        messages: anthropicMessages, // shape adapter ran once above; see toAnthropicMessages.
        ...(systemParam ? { system: systemParam } : {}),
        ...(opts.tools ? { tools: opts.tools as Tool[] } : {}),
      };
      response = await client.messages.create(createParams);
    } catch (err) {
      throw mapAnthropicError(err);
    }

    if (!('content' in response)) {
      throw new LLMProviderError(
        LLMError.UnknownProviderError,
        'Anthropic returned a streaming response — non-streaming expected',
      );
    }

    if (response.stop_reason === 'refusal') {
      throw new LLMProviderError(
        LLMError.ContentBlockedBySafetyFilter,
        'Anthropic refused to generate content',
      );
    }
    if (response.stop_reason === 'max_tokens') {
      throw new LLMProviderError(
        LLMError.UnknownProviderError,
        'Anthropic response truncated by max_tokens — output is incomplete',
      );
    }

    const toolUse = response.content
      .filter((b): b is ToolUseBlock => b.type === 'tool_use')
      .map((b) => ({
        id: b.id,
        name: b.name,
        input: b.input as Record<string, unknown>,
      }));
    const text = response.content
      .filter((b): b is TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('');

    const costUsd = pricing !== undefined ? computeAnthropicCost(response.usage, pricing) : 0;

    return {
      text,
      toolUse,
      usage: normalizeUsage(response.usage),
      costUsd,
    };
  }

  listModels(): ModelListing[] {
    return Object.keys(PRICING.anthropic).map((id) => {
      const row = PRICING.anthropic[id as keyof typeof PRICING.anthropic];
      return {
        id,
        inputUsdPer1M: row.inputUsdPer1M,
        outputUsdPer1M: row.outputUsdPer1M,
        cachedInputUsdPer1M: row.cachedInputUsdPer1M,
        cacheWriteUsdPer1M: row.cacheWriteUsdPer1M,
      };
    });
  }

  pricing(model: string): ModelListing | undefined {
    const row = (PRICING.anthropic as Record<string, AnthropicModelPricing>)[model];
    if (!row) return undefined;
    return {
      id: model,
      inputUsdPer1M: row.inputUsdPer1M,
      outputUsdPer1M: row.outputUsdPer1M,
      cachedInputUsdPer1M: row.cachedInputUsdPer1M,
      cacheWriteUsdPer1M: row.cacheWriteUsdPer1M,
    };
  }
}
