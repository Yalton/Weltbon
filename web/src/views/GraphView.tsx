import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { EmptyState } from '../components/EmptyState';
import { GraphCanvas } from '../components/GraphCanvas';
import { GraphTooltip } from '../components/GraphTooltip';
import {
  GraphSubgraphFilter,
  type SubgraphFocus,
} from '../components/GraphSubgraphFilter';
import { useGraphData, type GraphNode } from '../hooks/useGraphData';
import {
  usePinNode,
  useResetGraphLayout,
} from '../hooks/useGraphPositions';
import { neighborhood } from '../lib/neighborhood';

const SUBGRAPH_THRESHOLD = 300;

/**
 * /universes/:uid/graph — force-directed graph of entries and links.
 *
 * Orchestration seams:
 *  - useGraphData: one query for nodes + edges + positions
 *  - GraphCanvas: SVG + d3-force; click/hover/pin callbacks bubble up
 *  - GraphSubgraphFilter: replaces the canvas when nodes.length > 300
 *
 * When a universe exceeds SUBGRAPH_THRESHOLD nodes we render the subgraph
 * filter alongside the canvas area. The canvas only mounts once the user
 * picks a focus entry; at that point nodes and edges get filtered down via
 * the pure neighborhood() BFS library.
 */
export function GraphView() {
  const { uid } = useParams<{ uid: string }>();
  const navigate = useNavigate();
  const universeId = uid ?? '';

  const { data, isLoading } = useGraphData(universeId);
  const pin = usePinNode(universeId);
  const reset = useResetGraphLayout(universeId);

  const [focus, setFocus] = useState<SubgraphFocus | null>(null);
  const [hovered, setHovered] = useState<{ node: GraphNode; x: number; y: number } | null>(null);

  // Responsive sizing — observe the container so the SVG fills the outlet.
  const containerRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 800, height: 600 });
  useEffect(() => {
    if (!containerRef.current) return;
    const el = containerRef.current;
    // jsdom doesn't implement ResizeObserver; fall back gracefully so tests
    // don't explode (they assert DOM structure, not pixel dimensions).
    if (typeof ResizeObserver === 'undefined') {
      const rect = el.getBoundingClientRect();
      setSize({
        width: Math.max(200, rect.width || 800),
        height: Math.max(200, rect.height || 600),
      });
      return;
    }
    const ro = new ResizeObserver(([entry]) => {
      const r = entry.contentRect;
      setSize({
        width: Math.max(200, r.width || 800),
        height: Math.max(200, r.height || 600),
      });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const visible = useMemo(() => {
    if (!data) return { nodes: [], edges: [] };
    if (data.nodes.length <= SUBGRAPH_THRESHOLD) {
      return { nodes: data.nodes, edges: data.edges };
    }
    if (!focus) return { nodes: [], edges: [] };
    const keep = neighborhood(data.edges, focus.entryId, focus.hops);
    return {
      nodes: data.nodes.filter((n) => keep.has(n.id)),
      edges: data.edges.filter((e) => keep.has(e.source) && keep.has(e.target)),
    };
  }, [data, focus]);

  if (isLoading || !data) {
    return <p className="p-6 text-sm text-neutral-500">Loading graph…</p>;
  }

  if (data.nodes.length === 0) {
    return (
      <EmptyState
        title="The graph draws itself once entries exist"
        body="Create entries and link them — relationships show up here automatically."
        action={
          <button
            type="button"
            onClick={() => navigate(`/universes/${universeId}/entries`)}
            className="bg-[color:var(--color-accent)] text-white text-sm font-medium px-4 py-2 rounded-md hover:opacity-90 focus:outline-none focus:ring-2 focus:ring-[color:var(--color-accent)] focus:ring-offset-2"
          >
            New entry
          </button>
        }
      />
    );
  }

  const overThreshold = data.nodes.length > SUBGRAPH_THRESHOLD;
  const canvasVisible = !overThreshold || !!focus;

  return (
    <div
      ref={containerRef}
      className="relative h-[calc(100vh-7rem)] w-full overflow-hidden"
    >
      <div className="pointer-events-none absolute inset-x-0 top-3 z-10 flex items-start justify-between gap-3 px-3">
        <div className="pointer-events-auto text-xs text-neutral-500">
          {data.nodes.length} {data.nodes.length === 1 ? 'entry' : 'entries'} · {data.edges.length}{' '}
          {data.edges.length === 1 ? 'link' : 'links'}
        </div>
        <button
          type="button"
          onClick={() => reset.mutate()}
          disabled={reset.isPending}
          className="pointer-events-auto rounded-md border border-neutral-300 bg-white/80 px-3 py-1.5 text-sm shadow-sm hover:bg-white dark:border-neutral-700 dark:bg-neutral-900/80 dark:text-neutral-100 dark:hover:bg-neutral-900"
        >
          Reset layout
        </button>
      </div>

      {overThreshold && (
        <GraphSubgraphFilter
          nodes={data.nodes}
          totalCount={data.nodes.length}
          focus={focus}
          onFocusChange={setFocus}
        />
      )}

      {canvasVisible && (
        <GraphCanvas
          nodes={visible.nodes}
          edges={visible.edges}
          positions={data.positions}
          width={size.width}
          height={size.height}
          onNodeClick={(node) => navigate(`/universes/${universeId}/entries/${node.id}`)}
          onPinNode={(node, x, y) => pin.mutate({ entryId: node.id, x, y })}
          onHoverNode={(node, x, y) =>
            setHovered(node ? { node, x, y } : null)
          }
          // Phase 19 — required props. Edit-mode wiring lands in Plan 19-02;
          // this plan only adds the canvas-side primitives. Default stubs
          // keep the view in pin-mode behavior unchanged.
          editMode={false}
          onLinkDragEnd={() => {}}
        />
      )}

      {hovered && (
        <GraphTooltip node={hovered.node} x={hovered.x} y={hovered.y} />
      )}
    </div>
  );
}
