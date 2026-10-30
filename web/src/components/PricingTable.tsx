
import { useState } from 'react';
import { PRICING, PRICING_AS_OF } from '../data/pricing';
import { useListModels } from '../hooks/useAudits';
import { useLlmKeys } from '../hooks/useLlmKeys';

const PROVIDER_LABELS: Record<'anthropic' | 'openai', string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
};

type AnyRow = {
  inputUsdPer1M: number;
  outputUsdPer1M: number;
  cachedInputUsdPer1M: number;
  contextWindow: number;
};

function formatUsd(value: number): string {
  return `$${value.toFixed(2)}`;
}

export function PricingTable() {
  const [open, setOpen] = useState(false);

  const anthropicRows = Object.entries(PRICING.anthropic) as Array<
    [string, AnyRow]
  >;
  const openaiRows = Object.entries(PRICING.openai) as Array<[string, AnyRow]>;

  // across both providers. PricingTable is provider-agnostic at the mount
  // CR-01 fix (2026-05-28): gate the per-provider `useListModels` call on
  // the resulting `liveOnlyCount` stays 0 anyway, so the D-07 caption is
  const { data: llmKeys } = useLlmKeys();
  const hasAnthropicKey = llmKeys?.some((k) => k.provider === 'anthropic') ?? false;
  const hasOpenAIKey = llmKeys?.some((k) => k.provider === 'openai') ?? false;
  const { data: anthropicListing } = useListModels(
    hasAnthropicKey ? 'anthropic' : undefined,
  );
  const { data: openaiListing } = useListModels(
    hasOpenAIKey ? 'openai' : undefined,
  );
  const liveOnlyAnthropic =
    anthropicListing?.models.filter((m) => !m.hasPricing).length ?? 0;
  const liveOnlyOpenAI =
    openaiListing?.models.filter((m) => !m.hasPricing).length ?? 0;
  const liveOnlyCount = liveOnlyAnthropic + liveOnlyOpenAI;

  return (
    <details
      className="mt-6"
      open={open}
      onToggle={(e) => setOpen(e.currentTarget.open)}
    >
      <summary className="text-sm font-medium cursor-pointer list-none">
        {open ? '▾' : '▸'} Models & pricing
      </summary>
      <p className="text-xs text-ink-muted mt-1">
        pricing as of {PRICING_AS_OF}
      </p>
      <div className="mt-3 overflow-x-auto">
        <table className="w-full text-sm">
          <caption className="sr-only">
            Per-model pricing for configured LLM providers
          </caption>
          <thead>
            <tr className="border-b border-line">
              <th
                scope="col"
                className="pb-2 text-left text-xs uppercase tracking-wide font-medium text-ink-muted"
              >
                Model
              </th>
              <th
                scope="col"
                className="pb-2 text-left text-xs uppercase tracking-wide font-medium text-ink-muted"
              >
                Input $/MTok
              </th>
              <th
                scope="col"
                className="pb-2 text-left text-xs uppercase tracking-wide font-medium text-ink-muted"
              >
                Output $/MTok
              </th>
              <th
                scope="col"
                className="pb-2 text-left text-xs uppercase tracking-wide font-medium text-ink-muted"
              >
                Cached input $/MTok
              </th>
              <th
                scope="col"
                className="pb-2 text-right text-xs uppercase tracking-wide font-medium text-ink-muted"
              >
                Context window
              </th>
            </tr>
          </thead>
          <tbody>
            {/* Anthropic group */}
            <tr className="bg-panel">
              <th
                colSpan={5}
                scope="colgroup"
                className="text-left px-3 py-2 text-xs uppercase tracking-wide font-medium text-ink-muted"
              >
                {PROVIDER_LABELS.anthropic}
              </th>
            </tr>
            {anthropicRows.map(([modelName, row]) => (
              <tr
                key={`anthropic-${modelName}`}
                className="border-b border-line last:border-0"
              >
                <td className="py-3 pr-4 text-sm leading-[1.5]">{modelName}</td>
                <td className="py-3 pr-4 tabular-nums text-sm leading-[1.5]">
                  {formatUsd(row.inputUsdPer1M)}
                </td>
                <td className="py-3 pr-4 tabular-nums text-sm leading-[1.5]">
                  {formatUsd(row.outputUsdPer1M)}
                </td>
                <td className="py-3 pr-4 tabular-nums text-sm leading-[1.5]">
                  {row.cachedInputUsdPer1M !== undefined
                    ? formatUsd(row.cachedInputUsdPer1M)
                    : '—'}
                </td>
                <td className="py-3 tabular-nums text-right text-sm leading-[1.5]">
                  {row.contextWindow.toLocaleString()}
                </td>
              </tr>
            ))}

            {/* OpenAI group */}
            <tr className="bg-panel">
              <th
                colSpan={5}
                scope="colgroup"
                className="text-left px-3 py-2 text-xs uppercase tracking-wide font-medium text-ink-muted"
              >
                {PROVIDER_LABELS.openai}
              </th>
            </tr>
            {openaiRows.map(([modelName, row]) => (
              <tr
                key={`openai-${modelName}`}
                className="border-b border-line last:border-0"
              >
                <td className="py-3 pr-4 text-sm leading-[1.5]">{modelName}</td>
                <td className="py-3 pr-4 tabular-nums text-sm leading-[1.5]">
                  {formatUsd(row.inputUsdPer1M)}
                </td>
                <td className="py-3 pr-4 tabular-nums text-sm leading-[1.5]">
                  {formatUsd(row.outputUsdPer1M)}
                </td>
                <td className="py-3 pr-4 tabular-nums text-sm leading-[1.5]">
                  {row.cachedInputUsdPer1M !== undefined
                    ? formatUsd(row.cachedInputUsdPer1M)
                    : '—'}
                </td>
                <td className="py-3 tabular-nums text-right text-sm leading-[1.5]">
                  {row.contextWindow.toLocaleString()}
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        {liveOnlyCount > 0 && (
          <p className="text-xs text-ink-muted mt-2">
            {liveOnlyCount} additional models available without published rates — see model picker in universe settings.
          </p>
        )}
      </div>
    </details>
  );
}
