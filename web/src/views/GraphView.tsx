import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { EmptyState } from '../components/EmptyState';
import { GraphCanvas } from '../components/GraphCanvas';
import { GraphTooltip } from '../components/GraphTooltip';
import {
  GraphSubgraphFilter,
  type SubgraphFocus,
} from '../components/GraphSubgraphFilter';
import { Toast } from '../components/Toast';
import { useGraphData, type GraphEdge, type GraphNode } from '../hooks/useGraphData';
import {
  usePinNode,
  useResetGraphLayout,
} from '../hooks/useGraphPositions';
import { neighborhood } from '../lib/neighborhood';

const SUBGRAPH_THRESHOLD = 300;

type ToastState = { message: string; variant: 'success' | 'error' } | null;

/**
 * Phase 19 Plan 19-02: popoverState is captured on drop-on-other but the
 * actual `<CreateLinkPopover>` rendering lands in Plan 19-04. Until then,
 * this view exposes the captured state via a test-only data attribute
 * (`data-testid="popover-anchor"`) so Tests 6-7 in GraphView.test.tsx can
 * lock the orchestration contract (from/to nodes + container-relative
 * coords + existingLabelHint) before the popover UI is built.
 */
type PopoverState = {
  from: GraphNode;
  to: GraphNode;
  dropX: number;
  dropY: number;
  existingLabelHint?: string;
} | null;

/**
 * Look up the most-recent (== first, since the graph-data API returns
 * edges in DESC createdAt order) link label for a (fromId, toId) pair.
 * Returns undefined if no edge matches or if the matching edge has an
 * empty label.
 *
 * Used by `handleLinkDragEnd` to prefill the popover label input with a
 * hint when A→B already exists (UI-SPEC D-03d "Existing-Link Merge").
 */
function lookupExistingLabel(
  edges: GraphEdge[],
  fromId: string,
  toId: string,
): string | undefined {
  const match = edges.find((e) => e.source === fromId && e.target === toId);
  return match?.label ? match.label : undefined;
}

/**
 * /universes/:uid/graph — force-directed graph of entries and links.
 *
 * Orchestration seams:
 *  - useGraphData: one query for nodes + edges + positions
 *  - GraphCanvas: SVG + d3-force; click/hover/pin/edit-mode-drag callbacks bubble up
 *  - GraphSubgraphFilter: replaces the canvas when nodes.length > 300
 *
 * Phase 19 Plan 19-02 additions:
 *  - editMode toggle (persistent button in the toolbar)
 *  - popoverState (captured on drop-on-different-node; rendered in 19-04)
 *  - toast state (self-drop + future link-creation error)
 *  - dragSourceId state (mirrored from GraphCanvas via onDragSourceChange)
 *  - canvas-level Esc handler gated on dragSourceId === null (UI-SPEC §G)
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

  // Phase 19 Plan 19-02 — orchestration state.
  const [editMode, setEditMode] = useState(false);
  const [popoverState, setPopoverState] = useState<PopoverState>(null);
  const [toast, setToast] = useState<ToastState>(null);
  // Mirrors GraphCanvas's internal drag-source state via the optional
  // onDragSourceChange callback so the canvas-level Esc useEffect below
  // can short-circuit while a drag is in flight (UI-SPEC §G items 3 vs 4:
  // Esc during a drag belongs to the drag's own listener in GraphCanvas,
  // NOT to the edit-mode toggle).
  const [dragSourceId, setDragSourceId] = useState<string | null>(null);

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

  // Canvas-level Esc handler — exits edit mode when no popover is open and
  // no drag is in flight (UI-SPEC §G item 4). The `dragSourceId !== null`
  // short-circuit is REQUIRED by the §G priority list: a single Esc
  // keydown during a drag belongs to item 3 (GraphCanvas's mid-drag
  // listener); only Esc with `dragSourceId === null` and `popoverState ===
  // null` belongs to item 4 (edit-mode exit).
  //
  // Lifecycle note: while a drag is in flight, this effect re-runs with
  // dragSourceId='X' and short-circuits — its `window.addEventListener` is
  // NOT installed. The mid-drag Esc keydown therefore reaches ONLY
  // GraphCanvas's listener. When GraphCanvas emits onDragSourceChange(null)
  // on Esc-cancel, this effect re-runs with dragSourceId=null and installs
  // its listener — but the user has already released Esc. A SUBSEQUENT
  // Esc press is the one that exits edit mode. This matches UI-SPEC §G
  // "Esc order of priority" verbatim and is locked by Test 10.
  useEffect(() => {
    if (!editMode || popoverState !== null || dragSourceId !== null) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setEditMode(false);
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [editMode, popoverState, dragSourceId]);

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

  /**
   * GraphCanvas → GraphView callback for edit-mode drag ends. Routes the
   * three drop outcomes:
   *   - `to === null`     → empty canvas; silent cancel (no toast, no popover).
   *   - `to === 'self'`   → self-drop; render error Toast with locked copy.
   *   - `to: GraphNode`   → drop on different node; capture popoverState
   *                          with container-relative coords + an
   *                          existingLabelHint when A→B already exists.
   *
   * dropClientX / dropClientY are screen-space (from
   * evt.sourceEvent.clientX/Y in GraphCanvas's d3-drag end handler — see
   * Plan 19-02 Task 1). They are converted to container-relative
   * coordinates here so the popover anchor (Plan 19-04) can be styled
   * with plain `left` / `top` against `containerRef`'s `position:
   * relative` parent.
   */
  const handleLinkDragEnd = (
    from: GraphNode,
    to: GraphNode | 'self' | null,
    dropClientX: number,
    dropClientY: number,
  ) => {
    if (to === null) return; // silent cancel
    if (to === 'self') {
      setToast({
        message: "Can't link an entry to itself.",
        variant: 'error',
      });
      return;
    }
    const rect = containerRef.current?.getBoundingClientRect();
    const dropX = dropClientX - (rect?.left ?? 0);
    const dropY = dropClientY - (rect?.top ?? 0);
    const existingLabelHint = lookupExistingLabel(data.edges, from.id, to.id);
    setPopoverState({ from, to, dropX, dropY, existingLabelHint });
  };

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
        <div className="pointer-events-auto flex items-center gap-2">
          <button
            type="button"
            onClick={() => setEditMode((v) => !v)}
            aria-pressed={editMode}
            aria-label={editMode ? 'Exit edit mode' : 'Enter edit mode'}
            title={
              editMode
                ? 'Press Esc to exit edit mode'
                : 'Drag between entries to create a link'
            }
            className={[
              'rounded-md px-3 py-1.5 text-sm shadow-sm transition-colors',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--color-accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-white dark:focus-visible:ring-offset-neutral-900',
              editMode
                ? 'border border-[color:var(--color-accent)] bg-[color:var(--color-accent-soft)] text-[color:var(--color-accent)]'
                : 'border border-neutral-300 bg-white/80 hover:bg-white dark:border-neutral-700 dark:bg-neutral-900/80 dark:text-neutral-100 dark:hover:bg-neutral-900',
            ].join(' ')}
          >
            {editMode ? 'Editing' : 'Edit'}
          </button>
          <button
            type="button"
            onClick={() => reset.mutate()}
            disabled={reset.isPending}
            className="rounded-md border border-neutral-300 bg-white/80 px-3 py-1.5 text-sm shadow-sm hover:bg-white dark:border-neutral-700 dark:bg-neutral-900/80 dark:text-neutral-100 dark:hover:bg-neutral-900"
          >
            Reset layout
          </button>
        </div>
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
          // Phase 19 Plan 19-02 — edit-mode wiring.
          editMode={editMode}
          onLinkDragEnd={handleLinkDragEnd}
          onDragSourceChange={setDragSourceId}
        />
      )}

      {hovered && (
        <GraphTooltip node={hovered.node} x={hovered.x} y={hovered.y} />
      )}

      {/*
        Plan 19-04 will mount <CreateLinkPopover> here. Until then, render
        a test-only anchor div so Tests 6-7 can lock the orchestration
        contract (popoverState captures + existingLabelHint lookup). The
        anchor div is `display: none` so it has no visual impact during
        the 19-02 → 19-04 gap.
      */}
      {popoverState && (
        <div
          data-testid="popover-anchor"
          data-from-id={popoverState.from.id}
          data-to-id={popoverState.to.id}
          data-drop-x={popoverState.dropX}
          data-drop-y={popoverState.dropY}
          data-existing-label-hint={popoverState.existingLabelHint ?? ''}
          style={{ display: 'none' }}
        />
      )}

      {toast && (
        <Toast
          message={toast.message}
          variant={toast.variant}
          onDismiss={() => setToast(null)}
          durationMs={3000}
        />
      )}
    </div>
  );
}
