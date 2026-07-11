import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { CreateLinkPopover } from '../components/CreateLinkPopover';
import { EmptyState } from '../components/EmptyState';
import { GraphCanvas } from '../components/GraphCanvas';
import { GraphTooltip } from '../components/GraphTooltip';
import { RelationLegend } from '../components/RelationLegend';
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
import { useUniverse, useUpdateUniverse } from '../hooks/useUniverse';
import { neighborhood } from '../lib/neighborhood';
import { useShareMode } from '../contexts/ShareModeContext';

const LEGEND_STORAGE_KEY = 'weltbon.legendVisible';
const SUBGRAPH_THRESHOLD = 300;

type ToastState = { message: string; variant: 'success' | 'error' } | null;

/**
 * Phase 19 Plan 19-04: popoverState drives the conditional <CreateLinkPopover>
 * render at the bottom of this view. from/to are the dragged GraphNodes;
 * dropX/Y are container-relative pixel coords for the popover anchor;
 * existingLabelHint pre-fills the popover's label input when an A→B edge
 * already exists (CONTEXT.md D-03d).
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
  // Phase 29 — share-mode awareness. In share mode the route is
  // `/share/:token/graph` (no `uid` param); substitute the literal 'share'
  // so the existing useGraphData(universeId) hook builds a path the
  // api-client seam can translate to /api/share/graph-data. The `token`
  // param drives navigation back into the share subtree on node click.
  const { uid: paramUid, token } = useParams<{ uid: string; token: string }>();
  const isShareMode = useShareMode();
  const uid = paramUid ?? (isShareMode ? 'share' : undefined);
  const navigate = useNavigate();
  const universeId = uid ?? '';

  const { data, isLoading } = useGraphData(universeId);
  const pin = usePinNode(universeId);
  const reset = useResetGraphLayout(universeId);

  // Phase 28 REL-02: per-universe link-type registry for edge coloring + legend.
  const { data: universe } = useUniverse(universeId);
  const updateUniverse = useUpdateUniverse(universeId);
  const linkTypeRegistry = universe?.linkTypes ?? {};

  // Legend visibility persisted to localStorage (default: true).
  const [legendVisible, setLegendVisible] = useState<boolean>(() => {
    try {
      const stored = localStorage.getItem(LEGEND_STORAGE_KEY);
      return stored === null ? true : stored !== 'false';
    } catch {
      return true;
    }
  });

  const handleLegendToggle = useCallback(() => {
    setLegendVisible((v) => {
      const next = !v;
      try {
        localStorage.setItem(LEGEND_STORAGE_KEY, String(next));
      } catch {
        // localStorage unavailable (e.g. private browsing quota) — silent fail
      }
      return next;
    });
  }, []);

  const handleLegendColorChange = useCallback(
    (linkType: string, color: string) => {
      if (!universe) return;
      updateUniverse.mutate({
        linkTypes: {
          ...universe.linkTypes,
          [linkType]: {
            ...universe.linkTypes?.[linkType],
            color,
          },
        },
      });
    },
    [universe, updateUniverse],
  );

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
        body={
          isShareMode
            ? 'There are no public entries to graph in this universe yet.'
            : 'Create entries and link them — relationships show up here automatically.'
        }
        action={
          // Phase 29 D-18 — no "New entry" CTA for visitors.
          !isShareMode ? (
            <button
              type="button"
              onClick={() => navigate(`/universes/${universeId}/entries`)}
              className="bg-[color:var(--color-accent)] text-white text-sm font-medium px-4 py-2 rounded-md hover:opacity-90 focus:outline-none focus:ring-2 focus:ring-[color:var(--color-accent)] focus:ring-offset-2"
            >
              New entry
            </button>
          ) : undefined
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
      className="relative h-full w-full overflow-hidden"
    >
      <div className="pointer-events-none absolute inset-x-0 top-3 z-10 flex items-start justify-between gap-3 px-3">
        <div className="pointer-events-auto text-xs text-neutral-500">
          {data.nodes.length} {data.nodes.length === 1 ? 'entry' : 'entries'} · {data.edges.length}{' '}
          {data.edges.length === 1 ? 'link' : 'links'}
        </div>
        <div className="pointer-events-auto flex items-center gap-2">
          {/*
            Phase 29 D-18 / UI-SPEC §A — in share mode the entire toolbar
            mutation cluster (Edit-mode toggle for drag-to-link, Reset
            layout) is hidden. The graph canvas itself, the subgraph
            filter UI, node click navigation, hover tooltip, and pan/zoom
            remain — they are pure reads.
          */}
          {!isShareMode && (
            <>
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
              {data.edges.length > 0 && (
                <button
                  type="button"
                  onClick={handleLegendToggle}
                  aria-pressed={legendVisible}
                  aria-label={legendVisible ? 'Hide relation legend' : 'Show relation legend'}
                  className="rounded-md border border-neutral-300 bg-white/80 px-3 py-1.5 text-sm shadow-sm hover:bg-white dark:border-neutral-700 dark:bg-neutral-900/80 dark:text-neutral-100 dark:hover:bg-neutral-900"
                >
                  {legendVisible ? 'Hide legend' : 'Show legend'}
                </button>
              )}
            </>
          )}
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
          onNodeClick={(node) =>
            isShareMode
              ? navigate(`/share/${token ?? ''}/entries/${node.id}`)
              : navigate(`/universes/${universeId}/entries/${node.id}`)
          }
          // Pin (drag-to-reposition save) is a mutation — silently no-op
          // in share mode; the visitor cannot persist layout state.
          onPinNode={
            isShareMode
              ? () => {
                  /* read-only: positions are owner state */
                }
              : (node, x, y) => pin.mutate({ entryId: node.id, x, y })
          }
          onHoverNode={(node, x, y) =>
            setHovered(node ? { node, x, y } : null)
          }
          // Phase 29 — share mode forces editMode=false at the canvas
          // boundary so the drag-to-link gesture is unreachable even if
          // editMode state were somehow toggled (defense in depth — the
          // toolbar toggle is hidden, but this is the canvas-level guard).
          editMode={isShareMode ? false : editMode}
          onLinkDragEnd={handleLinkDragEnd}
          onDragSourceChange={setDragSourceId}
          // Phase 28 REL-02 — link-type color registry.
          linkTypeRegistry={linkTypeRegistry}
        />
      )}

      {hovered && (
        <GraphTooltip node={hovered.node} x={hovered.x} y={hovered.y} />
      )}

      {/* Phase 28 REL-02: toggle-able legend overlay. Uses pointer-events-none
          wrapper (same pattern as GraphTooltip) so d3-zoom pan/drag is not
          intercepted. Visibility persisted to localStorage. */}
      <RelationLegend
        edges={data.edges}
        registry={linkTypeRegistry}
        visible={legendVisible}
        onToggle={handleLegendToggle}
        onColorChange={handleLegendColorChange}
      />

      {/*
        Phase 19 Plan 19-04: CreateLinkPopover mounted conditionally on
        popoverState !== null. onOpenChange(false) clears popoverState so
        Esc / outside-click / Cancel / post-success all route to the same
        cleanup. onError fires the per-view Toast with the locked
        belt-and-suspenders error copy (UI-SPEC §H — identical to the
        popover's inline error).

        Phase 29: In share mode the popover is never mounted — editMode
        is forced false above, so the drop callback never reaches the
        popover-state setter. The `!isShareMode` guard here is
        belt-and-suspenders for the same constraint.
      */}
      {popoverState && !isShareMode && (
        <CreateLinkPopover
          universeId={universeId}
          open={true}
          onOpenChange={(open) => {
            if (!open) setPopoverState(null);
          }}
          from={popoverState.from}
          to={popoverState.to}
          dropX={popoverState.dropX}
          dropY={popoverState.dropY}
          existingLabelHint={popoverState.existingLabelHint}
          onError={() =>
            setToast({
              message: "Couldn't create link. Try again.",
              variant: 'error',
            })
          }
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
