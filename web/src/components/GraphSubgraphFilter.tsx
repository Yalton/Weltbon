import type { GraphNode } from '../hooks/useGraphData';

export interface SubgraphFocus {
  entryId: string;
  hops: number;
}

export interface GraphSubgraphFilterProps {
  nodes: GraphNode[];
  totalCount: number;
  focus: SubgraphFocus | null;
  onFocusChange: (focus: SubgraphFocus | null) => void;
}

/**
 * Banner + focus-entry picker + hop-depth selector shown when a universe has
 * more than SUBGRAPH_THRESHOLD nodes. The user picks a focus entry and a hop
 * count; the parent GraphView filters the node/edge sets to the computed
 * neighborhood before handing them to GraphCanvas.
 *
 * Why cap the option list at 2000: rendering 10k+ <option> elements stalls
 * the browser in-select. Beyond 2000 entries the user should rely on search
 * (Plan 03-03) or categories (Plan 03-06) to navigate instead.
 */
export function GraphSubgraphFilter({
  nodes,
  totalCount,
  focus,
  onFocusChange,
}: GraphSubgraphFilterProps) {
  return (
    <div
      className="pointer-events-auto mx-auto mt-8 max-w-xl rounded-md border border-amber-500/40 bg-amber-500/10 p-5 text-sm"
      role="region"
      aria-label="Subgraph filter"
    >
      <p className="font-medium text-amber-200">
        {`This universe has ${totalCount} entries — too many to render at once.`}
      </p>
      <p className="mt-1 text-amber-100/80">
        Pick a focus entry and a hop depth to narrow the view.
      </p>
      <div className="mt-4 flex flex-col gap-2 sm:flex-row">
        <label className="flex-1">
          <span className="sr-only">Focus entry</span>
          <select
            aria-label="Focus entry"
            value={focus?.entryId ?? ''}
            onChange={(e) => {
              const id = e.target.value;
              if (!id) {
                onFocusChange(null);
              } else {
                onFocusChange({ entryId: id, hops: focus?.hops ?? 1 });
              }
            }}
            className="w-full rounded-md border border-neutral-300 bg-transparent px-2 py-1 text-sm text-neutral-900 dark:border-neutral-700 dark:text-neutral-100"
          >
            <option value="">Pick focus entry…</option>
            {nodes.slice(0, 2000).map((n) => (
              <option key={n.id} value={n.id}>
                {n.title}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span className="sr-only">Hop depth</span>
          <select
            aria-label="Hop depth"
            value={focus?.hops ?? 1}
            onChange={(e) => {
              const hops = Number(e.target.value);
              if (focus) {
                onFocusChange({ ...focus, hops });
              }
            }}
            disabled={!focus}
            className="rounded-md border border-neutral-300 bg-transparent px-2 py-1 text-sm text-neutral-900 disabled:opacity-60 dark:border-neutral-700 dark:text-neutral-100"
          >
            <option value="1">1 hop</option>
            <option value="2">2 hops</option>
            <option value="3">3 hops</option>
          </select>
        </label>
      </div>
    </div>
  );
}
