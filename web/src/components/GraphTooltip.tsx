import type { GraphNode } from '../hooks/useGraphData';

export interface GraphTooltipProps {
  node: GraphNode | null;
  x: number;
  y: number;
}

export function GraphTooltip({ node, x, y }: GraphTooltipProps) {
  if (!node) return null;
  return (
    <div
      style={{ left: x + 12, top: y + 12 }}
      className="pointer-events-none absolute max-w-xs rounded border border-[color:var(--color-ink-muted)] bg-ink-muted px-3 py-2 text-sm text-ink-muted shadow-lg"
      role="tooltip"
    >
      <div className="flex items-center gap-2 font-medium">
        {node.icon && <span aria-hidden="true">{node.icon}</span>}
        <span>{node.title}</span>
      </div>
      <div className="text-xs text-ink-muted">{node.entryType}</div>
      {node.summary && <p className="mt-1 text-xs text-ink-muted">{node.summary}</p>}
    </div>
  );
}
