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
      </div>
    </details>
  );
}
