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
import { useEntryMedallions } from '../hooks/useEntryMedallions';
import { useUniverse, useUpdateUniverse } from '../hooks/useUniverse';
import { neighborhood } from '../lib/neighborhood';
import { useShareMode } from '../contexts/ShareModeContext';

const LEGEND_STORAGE_KEY = 'weltbon.legendVisible';
const SUBGRAPH_THRESHOLD = 300;

type ToastState = { message: string; variant: 'success' | 'error' } | null;

type PopoverState = {
  from: GraphNode;
  to: GraphNode;
  dropX: number;
  dropY: number;
  existingLabelHint?: string;
} | null;

function lookupExistingLabel(
  edges: GraphEdge[],
  fromId: string,
  toId: string,
): string | undefined {
  const match = edges.find((e) => e.source === fromId && e.target === toId);
  return match?.label ? match.label : undefined;
}

export function GraphView() {
  // api-client seam can translate to /api/share/graph-data. The `token`
  const { uid: paramUid, token } = useParams<{ uid: string; token: string }>();
  const isShareMode = useShareMode();
  const uid = paramUid ?? (isShareMode ? 'share' : undefined);
  const navigate = useNavigate();
  const universeId = uid ?? '';

  const { data, isLoading } = useGraphData(universeId);
  const pin = usePinNode(universeId);
  const reset = useResetGraphLayout(universeId);

  const { data: universe } = useUniverse(universeId);
  const updateUniverse = useUpdateUniverse(universeId);
  const linkTypeRegistry = universe?.linkTypes ?? {};

  // Cover art comes from the entries LIST cache — /graph-data has no cover field.
  const medallions = useEntryMedallions(universeId);

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

  const [editMode, setEditMode] = useState(false);
  const [popoverState, setPopoverState] = useState<PopoverState>(null);
  const [toast, setToast] = useState<ToastState>(null);
  // Mirrors GraphCanvas's internal drag-source state via the optional
  // onDragSourceChange callback so the canvas-level Esc useEffect below
  // can short-circuit while a drag is in flight (UI-SPEC §G items 3 vs 4:
  // NOT to the edit-mode toggle).
  const [dragSourceId, setDragSourceId] = useState<string | null>(null);

  const containerRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 800, height: 600 });
  useEffect(() => {
    if (!containerRef.current) return;
    const el = containerRef.current;
    const readSize = (observed?: { width: number; height: number }) => {
      const rect = el.getBoundingClientRect();
      const width = Math.max(200, Math.round(observed?.width || rect.width || el.clientWidth || 800));
      const height = Math.max(200, Math.round(observed?.height || rect.height || el.clientHeight || 600));
      setSize((previous) =>
        previous.width === width && previous.height === height
          ? previous
          : { width, height },
      );
    };

    // ResizeObserver notification is delayed, stretching a corner-clustered
    readSize();
    const frameId = typeof window.requestAnimationFrame === 'function'
      ? window.requestAnimationFrame(() => readSize())
      : null;
    const ro = typeof ResizeObserver === 'undefined'
      ? null
      : new ResizeObserver(([entry]) => readSize(entry.contentRect));
    const handleWindowResize = () => readSize();
    ro?.observe(el);
    window.addEventListener('resize', handleWindowResize);
    return () => {
      if (frameId !== null) window.cancelAnimationFrame(frameId);
      ro?.disconnect();
      window.removeEventListener('resize', handleWindowResize);
    };
  }, [isLoading, data, focus]);

  // Canvas-level Esc handler — exits edit mode when no popover is open and
  // no drag is in flight (UI-SPEC §G item 4). The `dragSourceId !== null`
  // short-circuit is REQUIRED by the §G priority list: a single Esc
  // keydown during a drag belongs to item 3 (GraphCanvas's mid-drag
  // null` belongs to item 4 (edit-mode exit).
  // Lifecycle note: while a drag is in flight, this effect re-runs with
  // dragSourceId='X' and short-circuits — its `window.addEventListener` is
  // NOT installed. The mid-drag Esc keydown therefore reaches ONLY
  // on Esc-cancel, this effect re-runs with dragSourceId=null and installs
  // Esc press is the one that exits edit mode. This matches UI-SPEC §G
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
    return <p className="p-6 text-sm text-ink-muted">Loading graph…</p>;
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
        <div className="pointer-events-auto text-xs text-ink-muted">
          {data.nodes.length} {data.nodes.length === 1 ? 'entry' : 'entries'} · {data.edges.length}{' '}
          {data.edges.length === 1 ? 'link' : 'links'}
        </div>
        <div className="pointer-events-auto flex items-center gap-2">

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
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--color-accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[color:var(--color-canvas-mid)]',
                  editMode
                    ? 'border border-[color:var(--color-accent)] bg-[color:var(--color-accent-soft)] text-[color:var(--color-accent)]'
                    : 'border border-line-strong bg-panel text-ink hover:bg-white/[0.03]',
                ].join(' ')}
              >
                {editMode ? 'Editing' : 'Edit'}
              </button>
              <button
                type="button"
                onClick={() => reset.mutate()}
                disabled={reset.isPending}
                className="rounded-md border px-3 py-1.5 text-sm shadow-sm border-line-strong bg-panel text-ink hover:bg-white/[0.03]"
              >
                Reset layout
              </button>
              {data.edges.length > 0 && (
                <button
                  type="button"
                  onClick={handleLegendToggle}
                  aria-pressed={legendVisible}
                  aria-label={legendVisible ? 'Hide relation legend' : 'Show relation legend'}
                  className="rounded-md border px-3 py-1.5 text-sm shadow-sm border-line-strong bg-panel text-ink hover:bg-white/[0.03]"
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
          onPinNode={
            isShareMode
              ? () => {
                }
              : (node, x, y) => pin.mutate({ entryId: node.id, x, y })
          }
          onHoverNode={(node, x, y) =>
            setHovered(node ? { node, x, y } : null)
          }
          // boundary so the drag-to-link gesture is unreachable even if
          // toolbar toggle is hidden, but this is the canvas-level guard).
          editMode={isShareMode ? false : editMode}
          onLinkDragEnd={handleLinkDragEnd}
          onDragSourceChange={setDragSourceId}
          linkTypeRegistry={linkTypeRegistry}
          // Content-Forward Views §4 — cover/emoji/monogram per node.
          medallions={medallions}
        />
      )}

      {hovered && (
        <GraphTooltip node={hovered.node} x={hovered.x} y={hovered.y} />
      )}


      <RelationLegend
        edges={data.edges}
        registry={linkTypeRegistry}
        visible={legendVisible}
        onToggle={handleLegendToggle}
        onColorChange={handleLegendColorChange}
      />


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
