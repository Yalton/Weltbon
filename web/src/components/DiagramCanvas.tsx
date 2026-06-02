import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { drag } from 'd3-drag';
import { select } from 'd3-selection';
import { zoom, type ZoomBehavior } from 'd3-zoom';
import { entryTypeHexColor } from '../lib/entryTypeColor';
import { snapToGrid, DEFAULT_GRID_SIZE } from '../lib/diagramAlign';
import type { DiagramNode, DiagramEdge } from '../hooks/useDiagram';

// Canvas geometry constants — mirrors GraphCanvas.tsx
const NODE_RADIUS = 14;
const HALO_RADIUS = NODE_RADIUS + 4; // 18

/**
 * Richer node record accepted by the canvas — extends DiagramNode with the
 * display fields (title, entryType) that the editor joins from universe entries.
 * The editor (Plan 06) owns the join; the canvas is purely presentational.
 */
export interface CanvasNode extends DiagramNode {
  title: string;
  entryType: string;
}

// Stroke-dasharray values per line style (T-31-11 mitigation: map to fixed
// values, never interpolate arbitrary strings from untrusted edge data).
function dashArrayFor(lineStyle: 'solid' | 'dashed' | 'dotted' | null): string {
  switch (lineStyle) {
    case 'dashed':
      return '8 4';
    case 'dotted':
      return '2 4';
    case 'solid':
    default:
      return '';
  }
}

// Mutable node record used only inside the d3 effect (mirrors SimNode in GraphCanvas).
interface LayoutNode extends CanvasNode {
  x: number;
  y: number;
}

export interface DropCoords {
  x: number;
  y: number;
}

export interface DiagramCanvasProps {
  /** Diagram nodes with persisted x/y positions + display fields (title, entryType). */
  nodes: CanvasNode[];
  /** Diagram edges with lineStyle + color. */
  edges: DiagramEdge[];
  /** Currently selected node ids. */
  selection: Set<string>;
  /** Selected edge id, if any. */
  selectedEdgeId: string | null;
  /** When true: drag from node to node shows a preview edge and emits draw-edge intent. */
  editMode: boolean;
  /**
   * When true, node positions are snapped to the grid at drag-end before persisting.
   * Defaults to false — existing callers compile unchanged.
   */
  snapEnabled?: boolean;
  /**
   * Grid cell size in pixels for snap-to-grid.
   * Defaults to DEFAULT_GRID_SIZE (16px) when snapEnabled is true.
   */
  gridSize?: number;
  /**
   * Called when a node-to-node edit-mode drag succeeds (different nodes).
   * dropCoords are container-relative so the editor can anchor DrawEdgePopover.
   */
  onDrawEdge: (sourceEntryId: string, targetEntryId: string, dropCoords: DropCoords) => void;
  /** Called when a drag is released on the source node (self-drop). */
  onSelfDrop: () => void;
  /**
   * Called after a node drag ends with both the pre-drag and final canvas-space
   * positions so the editor can record an accurate undo op without consulting
   * the potentially-stale React-Query cache (CR-02 fix).
   */
  onMoveNode: (entryId: string, prevX: number, prevY: number, x: number, y: number) => void;
  /** Called when a node is clicked (single select; undefined to clear). */
  onSelectNode: (id: string | null, addToSelection?: boolean) => void;
  /** Called when an edge is clicked. */
  onSelectEdge: (id: string | null) => void;
  /** Surfaces the drag source id so the editor can gate its own Esc handler. */
  onDragSourceChange?: (sourceEntryId: string | null) => void;
  /**
   * Called when the user triggers the edit affordance on a selected edge.
   * dropCoords are container-relative for the editor to position DrawEdgePopover in edit mode.
   */
  onEditEdge?: (edgeId: string, dropCoords: DropCoords) => void;
  /**
   * Called when the user triggers the edit affordance on a selected node (rename intent).
   */
  onEditNode?: (nodeId: string) => void;
}

/**
 * SVG diagram canvas with fixed-position nodes, styled edges, pan/zoom, node
 * drag-to-reposition, selection rings, edit-mode drag-to-connect preview, and
 * mid-drag Esc cancel.
 *
 * Layer order (bottom to top): edges, edge-labels, preview-edge, selection-rings, halos, nodes.
 *
 * Security: node/edge labels are React text children of <text> — NEVER
 * dangerouslySetInnerHTML (T-31-10 mitigate). lineStyle is mapped to a fixed
 * strokeDasharray switch (T-31-11 mitigate).
 */
export const DiagramCanvas = forwardRef<SVGSVGElement, DiagramCanvasProps>(function DiagramCanvas({
  nodes,
  edges,
  selection,
  selectedEdgeId,
  editMode,
  snapEnabled = false,
  gridSize = DEFAULT_GRID_SIZE,
  onDrawEdge,
  onSelfDrop,
  onMoveNode,
  onSelectNode,
  onSelectEdge,
  onDragSourceChange,
  onEditEdge,
  onEditNode,
}, forwardedRef) {
  const svgRef = useRef<SVGSVGElement>(null);

  // Expose the internal svgRef to the parent via forwardRef so DiagramEditor
  // can read the live <svg> element for image export (Plan 10).
  useImperativeHandle(forwardedRef, () => svgRef.current as SVGSVGElement);

  // Stable callback refs so the d3 useEffect doesn't re-run on every render.
  const onDrawEdgeRef = useRef(onDrawEdge);
  const onSelfDropRef = useRef(onSelfDrop);
  const onMoveNodeRef = useRef(onMoveNode);
  const onSelectNodeRef = useRef(onSelectNode);
  const onSelectEdgeRef = useRef(onSelectEdge);
  const onDragSourceChangeRef = useRef(onDragSourceChange);
  const onEditEdgeRef = useRef(onEditEdge);
  const onEditNodeRef = useRef(onEditNode);
  const editModeRef = useRef(editMode);
  const selectionRef = useRef(selection);
  const snapEnabledRef = useRef(snapEnabled);
  const gridSizeRef = useRef(gridSize);
  useEffect(() => {
    onDrawEdgeRef.current = onDrawEdge;
    onSelfDropRef.current = onSelfDrop;
    onMoveNodeRef.current = onMoveNode;
    onSelectNodeRef.current = onSelectNode;
    onSelectEdgeRef.current = onSelectEdge;
    onDragSourceChangeRef.current = onDragSourceChange;
    onEditEdgeRef.current = onEditEdge;
    onEditNodeRef.current = onEditNode;
    editModeRef.current = editMode;
    selectionRef.current = selection;
    snapEnabledRef.current = snapEnabled;
    gridSizeRef.current = gridSize;
  });

  // Mid-drag cancel flag and live node registry for hit-testing.
  const cancelledRef = useRef(false);
  const layoutNodesRef = useRef<LayoutNode[]>([]);

  // React state for the edit-mode preview edge.
  const [dragSource, setDragSource] = useState<LayoutNode | null>(null);
  const [pointer, setPointer] = useState<{ x: number; y: number } | null>(null);

  // Alignment guide lines — shown while dragging in view mode when a node aligns
  // with another node's x or y within GUIDE_THRESHOLD pixels.
  const [guides, setGuides] = useState<{ axis: 'x' | 'y'; value: number }[]>([]);

  // Snap the live drag position to the grid if enabled (optional live preview).
  // We apply snap on drag-end definitively; this provides visual feedback during drag.
  const [liveSnapPos, setLiveSnapPos] = useState<{ x: number; y: number } | null>(null);

  useEffect(() => {
    if (!svgRef.current) return;

    const svg = select(svgRef.current);
    const g = svg.select<SVGGElement>('g.viewport');

    // Build mutable layout copies — drag handler mutates x/y directly on these.
    const layoutNodes: LayoutNode[] = nodes.map((n) => ({ ...n }));
    layoutNodesRef.current = layoutNodes;

    // --- Edges layer ---
    const edgeSel = g
      .select<SVGGElement>('g.edges')
      .selectAll<SVGLineElement, DiagramEdge>('line')
      .data(edges, (d) => d.id)
      .join(
        (enter) =>
          enter
            .append('line')
            .attr('data-edge-id', (d) => d.id)
            .attr('stroke-width', 1.5)
            .style('cursor', 'pointer'),
        (update) => update,
        (exit) => exit.remove(),
      )
      .attr('stroke', (d) => d.color ?? '#6b7280')
      .attr('stroke-opacity', 0.85)
      .attr('stroke-dasharray', (d) => dashArrayFor(d.lineStyle))
      .attr('stroke-width', (d) => (d.id === selectedEdgeId ? 2.5 : 1.5));

    // Edge click handler — select edge, deselect nodes.
    edgeSel.on('click', (evt: MouseEvent, d) => {
      evt.stopPropagation();
      onSelectEdgeRef.current(d.id);
    });

    // Edge double-click handler — open edit affordance for selected edge.
    // dropCoords are container-relative so the editor can anchor DrawEdgePopover.
    edgeSel.on('dblclick', (evt: MouseEvent, d) => {
      evt.stopPropagation();
      const rect = svgRef.current?.getBoundingClientRect();
      const dropCoords: DropCoords = {
        x: evt.clientX - (rect?.left ?? 0),
        y: evt.clientY - (rect?.top ?? 0),
      };
      onEditEdgeRef.current?.(d.id, dropCoords);
    });

    // --- Edge labels layer ---
    const edgeLabelSel = g
      .select<SVGGElement>('g.edge-labels')
      .selectAll<SVGTextElement, DiagramEdge>('text.edge-label')
      .data(
        edges.filter((e) => e.label && e.label.length > 0),
        (d) => d.id,
      )
      .join(
        (enter) =>
          enter
            .append('text')
            .attr('class', 'edge-label')
            .attr('font-size', 12)
            .attr('fill', '#9ca3af')
            .attr('text-anchor', 'middle')
            .attr('pointer-events', 'none')
            .text((d) => d.label ?? ''),
        (update) => update.text((d) => d.label ?? ''),
        (exit) => exit.remove(),
      );

    // --- Edit-mode halos layer ---
    const haloSel = g
      .select<SVGGElement>('g.halos')
      .selectAll<SVGCircleElement, LayoutNode>('circle')
      .data(editMode ? layoutNodes : [], (d) => d.id)
      .join(
        (enter) =>
          enter
            .append('circle')
            .attr('data-halo-id', (d) => d.id)
            .attr('r', HALO_RADIUS)
            .attr('fill', 'none')
            .attr('stroke', 'var(--color-accent)')
            .attr('stroke-width', 2)
            .attr('stroke-opacity', 0.55)
            .attr('pointer-events', 'none'),
        (update) => update,
        (exit) => exit.remove(),
      );

    // --- Selection rings layer ---
    const selectionRingSel = g
      .select<SVGGElement>('g.selection-rings')
      .selectAll<SVGCircleElement, LayoutNode>('circle')
      .data(
        layoutNodes.filter((n) => selection.has(n.entryId)),
        (d) => d.id,
      )
      .join(
        (enter) =>
          enter
            .append('circle')
            .attr('r', HALO_RADIUS)
            .attr('fill', 'none')
            .attr('stroke', 'var(--color-accent)')
            .attr('stroke-width', 2)
            .attr('pointer-events', 'none'),
        (update) => update,
        (exit) => exit.remove(),
      );

    // --- Nodes layer ---
    const nodeSel = g
      .select<SVGGElement>('g.nodes')
      .selectAll<SVGGElement, LayoutNode>('g.node-group')
      .data(layoutNodes, (d) => d.id)
      .join(
        (enter) => {
          const grp = enter.append('g').attr('class', 'node-group').style('cursor', 'pointer');
          grp.append('circle').attr('data-node-id', (d) => d.id).attr('r', NODE_RADIUS);
          grp
            .append('text')
            .attr('data-node-label', (d) => d.id)
            .attr('font-size', 12)
            .attr('text-anchor', 'middle')
            .attr('pointer-events', 'none');
          return grp;
        },
        (update) => update,
        (exit) => exit.remove(),
      );

    // Update circle fill and node label text on every re-join.
    // LayoutNode extends CanvasNode which has .entryType and .title.
    nodeSel.select<SVGCircleElement>('circle')
      .attr('fill', (d) => entryTypeHexColor(d.entryType))
      .attr('stroke', '#111827')
      .attr('stroke-width', 1);

    nodeSel.select<SVGTextElement>('text')
      .attr('dy', NODE_RADIUS + 14) // below circle
      .text((d) => d.title)
      .attr('fill', '#111827')
      .attr('class', 'diagram-node-label');

    // Node click handler: select / multi-select / clear.
    nodeSel.on('click', (evt: MouseEvent, d) => {
      evt.stopPropagation();
      onSelectNodeRef.current(d.entryId, evt.shiftKey);
    });

    // Node double-click handler — open rename affordance.
    nodeSel.on('dblclick', (evt: MouseEvent, d) => {
      evt.stopPropagation();
      onEditNodeRef.current?.(d.entryId);
    });

    // --- Position writer (synchronous — no simulation tick needed) ---
    const writePositions = () => {
      // Edges: source/target by entryId.
      const nodeMap = new Map(layoutNodes.map((n) => [n.entryId, n]));
      edgeSel
        .attr('x1', (d) => nodeMap.get(d.sourceEntryId)?.x ?? 0)
        .attr('y1', (d) => nodeMap.get(d.sourceEntryId)?.y ?? 0)
        .attr('x2', (d) => nodeMap.get(d.targetEntryId)?.x ?? 0)
        .attr('y2', (d) => nodeMap.get(d.targetEntryId)?.y ?? 0);
      edgeLabelSel
        .attr('x', (d) => {
          const sx = nodeMap.get(d.sourceEntryId)?.x ?? 0;
          const tx = nodeMap.get(d.targetEntryId)?.x ?? 0;
          return (sx + tx) / 2;
        })
        .attr('y', (d) => {
          const sy = nodeMap.get(d.sourceEntryId)?.y ?? 0;
          const ty = nodeMap.get(d.targetEntryId)?.y ?? 0;
          return (sy + ty) / 2 - 4;
        });
      nodeSel.attr('transform', (d) => `translate(${d.x},${d.y})`);
      haloSel.attr('cx', (d) => d.x).attr('cy', (d) => d.y);
      selectionRingSel.attr('cx', (d) => d.x).attr('cy', (d) => d.y);
    };

    writePositions();

    // Threshold (in canvas pixels) within which an alignment guide line appears.
    const GUIDE_THRESHOLD = 8;

    // CR-02: Record the authoritative pre-drag position at drag-start, keyed by
    // entryId, so drag-end can pass prevX/prevY to onMoveNode without consulting
    // the possibly-stale React-Query cache.
    const dragStartPos = new Map<string, { x: number; y: number }>();

    // --- d3-drag (dual intent: reposition in view mode, draw-edge in edit mode) ---
    const dragBehavior = drag<SVGGElement, LayoutNode>()
      .on('start', (evt, d) => {
        if (editModeRef.current) {
          cancelledRef.current = false;
          setDragSource({ ...d });
          setPointer({ x: d.x, y: d.y });
          onDragSourceChangeRef.current?.(d.entryId);
        } else {
          // Record position at drag-start (before d.x/d.y are mutated by drag events).
          dragStartPos.set(d.entryId, { x: d.x, y: d.y });
          // Clear any lingering guides on new drag
          setGuides([]);
          setLiveSnapPos(null);
        }
      })
      .on('drag', (evt, d) => {
        if (editModeRef.current) {
          // Preview edge tracks pointer in canvas space.
          setPointer({ x: evt.x, y: evt.y });
        } else {
          // Reposition node live (synchronously — Animation Contract: no JS animation).
          // If snap is enabled, show snapped position during drag (visual feedback).
          let liveX = evt.x;
          let liveY = evt.y;
          if (snapEnabledRef.current) {
            const snapped = snapToGrid({ x: evt.x, y: evt.y }, gridSizeRef.current);
            liveX = snapped.x;
            liveY = snapped.y;
          }
          d.x = liveX;
          d.y = liveY;
          writePositions();

          // Compute alignment guides: check if this node's x or y aligns with others.
          const draggingId = d.entryId;
          const newGuides: { axis: 'x' | 'y'; value: number }[] = [];
          for (const other of layoutNodesRef.current) {
            if (other.entryId === draggingId) continue;
            if (Math.abs(liveX - other.x) <= GUIDE_THRESHOLD) {
              newGuides.push({ axis: 'x', value: other.x });
            }
            if (Math.abs(liveY - other.y) <= GUIDE_THRESHOLD) {
              newGuides.push({ axis: 'y', value: other.y });
            }
          }
          setGuides(newGuides);
          setLiveSnapPos({ x: liveX, y: liveY });
        }
      })
      .on('end', (evt, d) => {
        if (editModeRef.current) {
          if (cancelledRef.current) return;
          const se = evt.sourceEvent as MouseEvent | undefined;
          const dropClientX = typeof se?.clientX === 'number' ? se.clientX : 0;
          const dropClientY = typeof se?.clientY === 'number' ? se.clientY : 0;
          const target = hitTestNode(se, layoutNodesRef.current);
          if (target === null) {
            // Drop on empty canvas — silent cancel.
          } else if (target.entryId === d.entryId) {
            onSelfDropRef.current();
          } else {
            // Convert client coords to container-relative for popover anchor.
            const rect = svgRef.current?.getBoundingClientRect();
            const dropCoords: DropCoords = {
              x: dropClientX - (rect?.left ?? 0),
              y: dropClientY - (rect?.top ?? 0),
            };
            onDrawEdgeRef.current(d.entryId, target.entryId, dropCoords);
          }
          setDragSource(null);
          setPointer(null);
          onDragSourceChangeRef.current?.(null);
        } else {
          // Apply snap at drag-end (definitive — DIAGRAM-01 requirement).
          // T-31-21 mitigate: snapToGrid always returns finite numbers.
          let finalX = d.x;
          let finalY = d.y;
          if (snapEnabledRef.current) {
            const snapped = snapToGrid({ x: d.x, y: d.y }, gridSizeRef.current);
            finalX = snapped.x;
            finalY = snapped.y;
            d.x = finalX;
            d.y = finalY;
            writePositions();
          }
          // Clear guides on drag end
          setGuides([]);
          setLiveSnapPos(null);
          // Persist final position via onMoveNode callback.
          // Pass the pre-drag position captured at drag-start (CR-02 fix) so the
          // editor records an accurate undo op without querying the stale cache.
          const startPos = dragStartPos.get(d.entryId);
          const prevX = startPos?.x ?? finalX;
          const prevY = startPos?.y ?? finalY;
          dragStartPos.delete(d.entryId);
          onMoveNodeRef.current(d.entryId, prevX, prevY, finalX, finalY);
        }
      });

    nodeSel.call(dragBehavior);

    // --- d3-zoom (scaleExtent [0.1, 4]) ---
    const zoomBehavior: ZoomBehavior<SVGSVGElement, unknown> = zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.1, 4])
      .on('zoom', (evt) => {
        g.attr('transform', evt.transform.toString());
      });
    svg.call(zoomBehavior);
    // Disable d3-zoom's built-in double-click-to-zoom so a double-click on a
    // node/edge opens the rename/edit-edge affordance instead of zooming the
    // canvas (31-08 checkpoint). Pan + wheel-zoom remain active.
    svg.on('dblclick.zoom', null);

    // Click on empty canvas clears selection.
    svg.on('click.canvas', (evt: MouseEvent) => {
      // Only clear when the click landed directly on the SVG, not on a node/edge.
      if (evt.target === svgRef.current || (evt.target as Element).closest('g.viewport') === g.node()) {
        const closest = (evt.target as Element).closest('[data-node-id],[data-edge-id]');
        if (!closest) {
          onSelectNodeRef.current(null);
          onSelectEdgeRef.current(null);
        }
      }
    });

    return () => {
      svg.on('.zoom', null);
      svg.on('click.canvas', null);
      nodeSel.on('click', null);
      nodeSel.on('dblclick', null);
      nodeSel.on('.drag', null);
      edgeSel.on('click', null);
      edgeSel.on('dblclick', null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodes, edges, selection, selectedEdgeId, editMode]);

  // Mid-drag Esc cancel — installed only while a drag is in flight.
  // Priority 2: cancel in-flight drag (UI-SPEC Esc order).
  useEffect(() => {
    if (!dragSource) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      cancelledRef.current = true;
      setDragSource(null);
      setPointer(null);
      onDragSourceChangeRef.current?.(null);
    };
    window.addEventListener('keydown', handler);
    return () => {
      window.removeEventListener('keydown', handler);
    };
  }, [dragSource]);

  return (
    <svg
      ref={svgRef}
      role="application"
      aria-label="Diagram canvas"
      className={[
        'block h-full w-full select-none',
        editMode ? 'cursor-crosshair' : '',
      ]
        .filter(Boolean)
        .join(' ')}
      data-testid="diagram-canvas"
    >
      {/* SVG layer order (UI-SPEC): edges, edge-labels, preview-edge, selection-rings, halos, nodes.
          align-guides is added above nodes as a pointer-events:none layer (per plan spec). */}
      <g className="viewport">
        <g className="edges" />
        <g className="edge-labels" />
        <g className="preview-edge">
          {dragSource && pointer && (
            <line
              data-testid="diagram-preview-edge"
              x1={dragSource.x}
              y1={dragSource.y}
              x2={pointer.x}
              y2={pointer.y}
              stroke="var(--color-accent)"
              strokeWidth={2}
              strokeDasharray="6 4"
              strokeOpacity={0.8}
              pointerEvents="none"
            />
          )}
        </g>
        <g className="selection-rings" />
        <g className="halos" />
        <g className="nodes" />
        {/* Alignment guide lines: pointer-events:none, accent-colored thin lines.
            Show a vertical/horizontal line when the dragged node's x or y aligns
            (within GUIDE_THRESHOLD px) with another node. Purely visual — no animation
            (Animation Contract: node drag has NO animation, synchronous). */}
        {guides.length > 0 && (
          <g className="align-guides" pointerEvents="none" data-testid="align-guides">
            {guides.map((guide, i) =>
              guide.axis === 'x' ? (
                <line
                  key={`guide-x-${i}`}
                  x1={guide.value}
                  y1={-10000}
                  x2={guide.value}
                  y2={10000}
                  stroke="var(--color-accent)"
                  strokeWidth={1}
                  strokeOpacity={0.5}
                  strokeDasharray="4 4"
                />
              ) : (
                <line
                  key={`guide-y-${i}`}
                  x1={-10000}
                  y1={guide.value}
                  x2={10000}
                  y2={guide.value}
                  stroke="var(--color-accent)"
                  strokeWidth={1}
                  strokeOpacity={0.5}
                  strokeDasharray="4 4"
                />
              ),
            )}
          </g>
        )}
      </g>
    </svg>
  );
});

/**
 * Hit-test the layout node under the pointer at drag-end. Uses
 * document.elementFromPoint — halos/selection-rings/preview-edge are
 * pointer-events:none so the underlying node circle is the hit target.
 * Reads data-node-id from the closest circle ancestor.
 */
function hitTestNode(
  sourceEvent: Event | undefined,
  layoutNodes: LayoutNode[],
): LayoutNode | null {
  if (!sourceEvent) return null;
  const me = sourceEvent as MouseEvent;
  if (typeof me.clientX !== 'number' || typeof me.clientY !== 'number') return null;
  const el = document.elementFromPoint(me.clientX, me.clientY);
  if (!el) return null;
  const circle = (el as Element).closest('circle[data-node-id]');
  if (!circle) return null;
  const id = circle.getAttribute('data-node-id');
  if (!id) return null;
  return layoutNodes.find((n) => n.id === id) ?? null;
}
