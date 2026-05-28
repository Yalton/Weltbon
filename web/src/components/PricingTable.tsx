/**
 * PricingTable — collapsible per-provider model pricing table.
 *
 * Rendered on /settings/llm (Plan 26-05 placement). Default collapsed; user
 * clicks the `<details><summary>` to expand. Reads PRICING + PRICING_AS_OF
 * from web/src/data/pricing.ts (web-side mirror of api/src/providers/llm/pricing.ts;
 * see D-14 + PATTERNS critical-discovery #8 for the build-boundary rationale).
 *
 * W-4: the "Context window" cell renders the actual numeric value per row
 * (e.g. 200,000 / 400,000) — Plan 01 added the contextWindow field to every
 * PRICING row so this cell never falls back to "—".
 *
 * Layout parity: table classNames mirror web/src/views/LlmKeys.tsx for a
 * consistent /settings/llm visual rhythm.
 */

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

  // Phase 27 D-07: overflow caption — count live models absent from PRICING
  // across both providers. PricingTable is provider-agnostic at the mount
  // site (web/src/views/LlmKeys.tsx) so we sum the counts.
  //
  // CR-01 fix (2026-05-28): gate the per-provider `useListModels` call on
  // whether the caller has a key for that provider. Without this, a fresh
  // visit by a keyless user issues two 404s (`no_key_for_provider`) — and
  // the resulting `liveOnlyCount` stays 0 anyway, so the D-07 caption is
  // structurally unreachable for that population. Passing `undefined` keeps
  // `enabled: !!provider` off in `useListModels`, so no request fires.
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
      <p className="text-xs text-neutral-500 mt-1">
        pricing as of {PRICING_AS_OF}
      </p>
      <div className="mt-3 overflow-x-auto">
        <table className="w-full text-sm">
          <caption className="sr-only">
            Per-model pricing for configured LLM providers
          </caption>
          <thead>
            <tr className="border-b border-neutral-200 dark:border-neutral-800">
              <th
                scope="col"
                className="pb-2 text-left text-xs uppercase tracking-wide font-medium text-neutral-500"
              >
                Model
              </th>
              <th
                scope="col"
                className="pb-2 text-left text-xs uppercase tracking-wide font-medium text-neutral-500"
              >
                Input $/MTok
              </th>
              <th
                scope="col"
                className="pb-2 text-left text-xs uppercase tracking-wide font-medium text-neutral-500"
              >
                Output $/MTok
              </th>
              <th
                scope="col"
                className="pb-2 text-left text-xs uppercase tracking-wide font-medium text-neutral-500"
              >
                Cached input $/MTok
              </th>
              <th
                scope="col"
                className="pb-2 text-right text-xs uppercase tracking-wide font-medium text-neutral-500"
              >
                Context window
              </th>
            </tr>
          </thead>
          <tbody>
            {/* Anthropic group */}
            <tr className="bg-neutral-50 dark:bg-neutral-900">
              <th
                colSpan={5}
                scope="colgroup"
                className="text-left px-3 py-2 text-xs uppercase tracking-wide font-medium text-neutral-500"
              >
                {PROVIDER_LABELS.anthropic}
              </th>
            </tr>
            {anthropicRows.map(([modelName, row]) => (
              <tr
                key={`anthropic-${modelName}`}
                className="border-b border-neutral-100 dark:border-neutral-800 last:border-0"
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
            <tr className="bg-neutral-50 dark:bg-neutral-900">
              <th
                colSpan={5}
                scope="colgroup"
                className="text-left px-3 py-2 text-xs uppercase tracking-wide font-medium text-neutral-500"
              >
                {PROVIDER_LABELS.openai}
              </th>
            </tr>
            {openaiRows.map(([modelName, row]) => (
              <tr
                key={`openai-${modelName}`}
                className="border-b border-neutral-100 dark:border-neutral-800 last:border-0"
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
        {/* Phase 27 D-07 — overflow caption. Rendered only when the live
            listings have returned AND have at least one model absent from
            PRICING for either provider. Never shown when both queries are
            still pending (no flicker of "0 additional models …") because
            we count only via resolved `data`. */}
        {liveOnlyCount > 0 && (
          <p className="text-xs text-neutral-500 mt-2">
            {liveOnlyCount} additional models available without published rates — see model picker in universe settings.
          </p>
        )}
      </div>
    </details>
  );
}
