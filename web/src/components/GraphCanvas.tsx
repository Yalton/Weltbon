import { useEffect, useRef, useState } from 'react';
import {
  forceCenter,
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  type Simulation,
  type SimulationNodeDatum,
} from 'd3-force';
import { drag } from 'd3-drag';
import { select } from 'd3-selection';
import { zoom, zoomTransform, type ZoomBehavior } from 'd3-zoom';
import type { GraphEdge, GraphNode, GraphPosition } from '../hooks/useGraphData';
import { getLinkTypeColor, type LinkTypeRegistry } from '../lib/linkTypeColor';
import { edgeLabelPosition, seededGraphPosition } from '../lib/graphLayout';
import { appendMedallionNode } from './MedallionSVG';
import type { MedallionSource } from '../lib/medallion';

export interface GraphCanvasProps {
  nodes: GraphNode[];
  edges: GraphEdge[];
  positions: GraphPosition[];
  width: number;
  height: number;
  onNodeClick: (node: GraphNode) => void;
  onPinNode: (node: GraphNode, x: number, y: number) => void;
  onHoverNode?: (node: GraphNode | null, x: number, y: number) => void;
  /**
   * Phase 19 — edit-mode toggle. When true, the d3-drag handler switches
   * into "link creation" intent: pointerdown on a node mounts a preview
   * edge that tracks the pointer; pointerup hit-tests for a drop target
   * and calls onLinkDragEnd. View-mode pin behavior is preserved when
   * editMode is false.
   */
  editMode: boolean;
  /**
   * Fires on the end of an edit-mode drag.
   *   - to is a different node → drop succeeded
   *   - to === 'self' → pointerup over the source node itself
   *   - to === null → pointerup over empty canvas
   * The callback is NOT fired when the drag is cancelled mid-flight via Esc.
   *
   * Phase 19 plan 19-02 task 1: signature extended with dropClientX/dropClientY
   * (sourced from evt.sourceEvent.clientX/clientY) so GraphView can convert
   * those screen-space coordinates into its container-relative anchor for the
   * future CreateLinkPopover (UI-SPEC §E "Props contract"; RESEARCH §"Pitfall
   * 3 — coordinate-space mismatch").
   */
  onLinkDragEnd: (
    from: GraphNode,
    to: GraphNode | 'self' | null,
    dropClientX: number,
    dropClientY: number,
  ) => void;
  /**
   * Optional drag-source lifecycle callback. Surfaces the canvas's internal
   * drag state so the parent (GraphView) can gate its own Esc handler on
   * dragSourceId === null (UI-SPEC §G Esc order of priority).
   *   - Fires once with the source node id on edit-mode drag start.
   *   - Fires once with null on edit-mode drag end OR mid-drag Esc cancel.
   * Never both fire for a single drag; never zero. Not invoked in view mode.
   */
  onDragSourceChange?: (sourceId: string | null) => void;
  /**
   * Phase 28 REL-02: per-universe link-type color/direction registry.
   * Passed to getLinkTypeColor() for each edge stroke; an empty record
   * falls back to the preset palette / hash for unknown types.
   * Defaults to {} (no overrides) so existing callers do not need to pass it.
   */
  linkTypeRegistry?: LinkTypeRegistry;
  /**
   * Content-Forward Views §4 — entry id → cover/icon/monogram, from useEntryMedallions
   * (the entries LIST cache; /graph-data carries no cover). An id absent from the map falls
   * back to the node's own title/type/icon, so a cold entries cache still paints.
   */
  medallions?: Map<string, MedallionSource>;
}

// d3 mutates the node objects in-place, adding x/y/vx/vy and fx/fy. We keep
// the original GraphNode interface pure and describe the simulation copy as
// an intersection type.
type SimNode = GraphNode & SimulationNodeDatum & { fx?: number | null; fy?: number | null };

// Edge after forceLink().id() resolution: source/target are now node references.
interface SimEdge {
  id: string;
  source: SimNode | string;
  target: SimNode | string;
  label: string | null;
  linkType: string | null;
  direction: string;
}

const NODE_RADIUS = 14;
/** Clearance between a node's disc and its edit-mode halo / its collide radius. */
const HALO_GAP = 4;

/** Spec §4 — radius grows with edge count, capped so a hub can't dominate the canvas. */
function radiusForDegree(degree: number): number {
  return Math.min(26, Math.max(NODE_RADIUS, NODE_RADIUS + 2 * degree));
}

/** Keep the overview a map of relationships, not a wall of text. */
const LABEL_VISIBLE_ZOOM = 1.2;

/** Baseline distance from the disc's edge down to the title label. */
const LABEL_OFFSET = 13;

export function GraphCanvas({
  nodes,
  edges,
  positions,
  width,
  height,
  onNodeClick,
  onPinNode,
  onHoverNode,
  editMode,
  onLinkDragEnd,
  onDragSourceChange,
  linkTypeRegistry = {},
  medallions,
}: GraphCanvasProps) {
  const svgRef = useRef<SVGSVGElement>(null);
  // Latest callback refs so the useEffect doesn't need to re-run when the
  // parent re-renders with a new arrow function identity.
  const onNodeClickRef = useRef(onNodeClick);
  const onPinNodeRef = useRef(onPinNode);
  const onHoverNodeRef = useRef(onHoverNode);
  const editModeRef = useRef(editMode);
  const onLinkDragEndRef = useRef(onLinkDragEnd);
  const onDragSourceChangeRef = useRef(onDragSourceChange);
  useEffect(() => {
    onNodeClickRef.current = onNodeClick;
    onPinNodeRef.current = onPinNode;
    onHoverNodeRef.current = onHoverNode;
    editModeRef.current = editMode;
    onLinkDragEndRef.current = onLinkDragEnd;
    onDragSourceChangeRef.current = onDragSourceChange;
  });

  // Mirrored simNodes ref so the d3 keydown handler (mid-drag Esc) and the
  // drag-end handler can both look up the live simulation node by id without
  // re-running the main useEffect on every drag-state tick.
  const simNodesRef = useRef<SimNode[]>([]);
  // Tracks whether the in-flight drag was cancelled via Esc, so the d3-drag
  // `end` handler (which fires unconditionally on pointerup) can skip both
  // onLinkDragEnd and onDragSourceChange(null) emissions.
  const cancelledRef = useRef(false);

  // React state for the preview-edge rendering. dragSource changes once per
  // drag-source state transition (start, end, cancel) — low frequency. pointer
  // changes on every pointermove — accepted per RESEARCH §Pitfall 5; if jank
  // is profiled later, the fallback (direct DOM writes via d3) is documented.
  const [dragSource, setDragSource] = useState<SimNode | null>(null);
  const [pointer, setPointer] = useState<{ x: number; y: number } | null>(null);

  useEffect(() => {
    if (!svgRef.current) return;

    // Build mutable copies — d3 mutates node.x/y. Mutating the original props
    // would break React's contract.
    const posMap = new Map(positions.map((p) => [p.entryId, p]));
    const simNodes: SimNode[] = nodes.map((n, index) => {
      const p = posMap.get(n.id);
      const copy: SimNode = { ...n };
      if (p) {
        copy.x = p.x;
        copy.y = p.y;
        copy.fx = p.x;
        copy.fy = p.y;
      } else {
        const seed = seededGraphPosition(index, nodes.length, width, height);
        copy.x = seed.x;
        copy.y = seed.y;
      }
      return copy;
    });
    simNodesRef.current = simNodes;

    // Degree = edge count in the CURRENT view. Computed once per data change, never per tick.
    const degree = new Map<string, number>();
    for (const e of edges) {
      degree.set(e.source, (degree.get(e.source) ?? 0) + 1);
      degree.set(e.target, (degree.get(e.target) ?? 0) + 1);
    }
    const radiusOf = (id: string) => radiusForDegree(degree.get(id) ?? 0);
    const nodeById = new Map(nodes.map((node) => [node.id, node]));
    const collisionRadiusOf = (id: string) => {
      const titleLength = nodeById.get(id)?.title.length ?? 0;
      // Approximate the horizontal title footprint so the force layout leaves
      // room for labels as well as medallion discs. Cap the estimate so a long
      // title cannot push every other node off the canvas.
      const labelRadius = Math.min(96, 18 + titleLength * 2.8);
      return Math.max(radiusOf(id) + HALO_GAP, labelRadius);
    };

    const simEdges: SimEdge[] = edges.map((e) => ({
      id: e.id,
      source: e.source,
      target: e.target,
      label: e.label,
      linkType: e.linkType,
      direction: e.direction,
    }));
    const pinnedIds = new Set(positions.map((p) => p.entryId));

    const svg = select(svgRef.current);
    const g = svg.select<SVGGElement>('g.viewport');

    // Data-bind nodes, links, and edge labels. Using JOIN with a stable key
    // fn (edge/node id) so re-renders reuse DOM.
    const linkSel = g
      .select<SVGGElement>('g.links')
      .selectAll<SVGLineElement, SimEdge>('line')
      .data(simEdges, (d) => d.id)
      .join(
        (enter) =>
          enter
            .append('line')
            .attr('data-edge-id', (d) => d.id)
            .attr('stroke', (d) => getLinkTypeColor(d.linkType, linkTypeRegistry))
            .attr('stroke-opacity', 0.7)
            .attr('stroke-width', 1.25),
        (update) => update.attr('stroke', (d) => getLinkTypeColor(d.linkType, linkTypeRegistry)),
        (exit) => exit.remove(),
      );

    const labelsHidden = zoomTransform(svgRef.current).k < LABEL_VISIBLE_ZOOM;

    // Only render labels for edges whose label is non-empty. Uses a separate
    // .data() filter.
    const labelSel = g
      .select<SVGGElement>('g.edge-labels')
      .selectAll<SVGTextElement, SimEdge>('text.edge-label')
      .data(
        simEdges.filter((e) => e.label && e.label.length > 0),
        (d) => d.id,
      )
      .join(
        (enter) =>
          enter
            .append('text')
            .attr('class', 'edge-label')
            .attr('font-size', 10)
            .attr('fill', '#9ca3af')
            .attr('paint-order', 'stroke')
            .attr('stroke', 'var(--color-canvas-lo)')
            .attr('stroke-width', 5)
            .attr('stroke-linejoin', 'round')
            .attr('text-anchor', 'middle')
            .attr('pointer-events', 'none')
            .text((d) => d.label),
        (update) => update.text((d) => d.label),
        (exit) => exit.remove(),
      )
      .attr('opacity', labelsHidden ? 0 : 1);

    // Halo JOIN — populated only when editMode is true; empty array otherwise
    // so the <g class="halos"> group renders empty (no structural mount/unmount
    // on toggle; UI-SPEC §B Lifecycle, Pitfall 4 idempotence).
    //
    // The radius is set on the MERGED selection, not on enter: discs are now degree-scaled
    // (14–26), so a fixed halo radius would sit on or inside a hub's medallion ring — edit
    // mode's primary affordance would vanish on exactly the nodes users link the most. And
    // because degree changes with the data, an enter-only radius would go stale.
    const haloSel = g
      .select<SVGGElement>('g.halos')
      .selectAll<SVGCircleElement, SimNode>('circle')
      .data(editMode ? simNodes : [], (d) => d.id)
      .join(
        (enter) =>
          enter
            .append('circle')
            .attr('data-halo-id', (d) => d.id)
            .attr('fill', 'none')
            .attr('stroke', 'var(--color-accent)')
            .attr('stroke-width', 2)
            .attr('stroke-opacity', 0.55)
            .attr('pointer-events', 'none'),
        (update) => update,
        (exit) => exit.remove(),
      )
      .attr('r', (d) => radiusOf(d.id) + HALO_GAP);

    // Content-Forward Views §4 — a node is a <g>, not a circle: it carries a medallion
    // (disc + cover/emoji/monogram) AND its title label, and the tick handler moves the
    // whole group with a single transform.
    const nodeSel = g
      .select<SVGGElement>('g.nodes')
      .selectAll<SVGGElement, SimNode>('g[data-node-id]')
      .data(simNodes, (d) => d.id)
      .join(
        (enter) =>
          enter
            .append('g')
            .attr('data-node-id', (d) => d.id)
            .style('cursor', 'pointer'),
        (update) => update,
        (exit) => exit.remove(),
      );

    // Labels are only ever repainted by the zoom handler, so a node ENTERING at overview
    // scale would paint its label beside hidden neighbours. Seed from the live transform.

    // Label sub-join — one <text> per node, inside the node's own <g>, so the tick handler's
    // single transform moves the disc, the art AND the label together. Written BEFORE the
    // medallion so DOM order is always [label, medallion]: appendMedallionNode re-appends
    // its group after each purge, and painting the label first is the only order that stays
    // stable across re-renders (a label appended after the medallion would flip under it on
    // the second render).
    nodeSel
      .selectAll<SVGTextElement, SimNode>('text.node-label')
      .data(
        (d) => [d],
        (d) => d.id,
      )
      .join(
        (enter) =>
          enter
            .append('text')
            .attr('class', 'node-label')
            .attr('text-anchor', 'middle')
            .attr('font-size', 11)
            .attr('font-family', 'var(--font-sans)')
            .attr('fill', 'var(--color-ink-secondary)')
            .attr('pointer-events', 'none'),
        (update) => update,
        (exit) => exit.remove(),
      )
      .attr('y', (d) => radiusOf(d.id) + LABEL_OFFSET)
      .attr('opacity', labelsHidden ? 0 : 1)
      .text((d) => d.title);

    nodeSel.each(function (d) {
      const group = this as SVGGElement;
      const r = radiusOf(d.id);
      const source: MedallionSource = medallions?.get(d.id) ?? {
        title: d.title,
        entryType: d.entryType,
        icon: d.icon,
        coverThumbUrl: null,
      };
      // appendMedallionNode purges and rebuilds the whole subtree, which restarts the cover
      // <image>'s load. `positions` is in the effect deps, so pinning ONE node would
      // otherwise re-fetch every cover on the canvas. Rebuild only when what the medallion
      // draws has actually changed.
      const sig = `${r}|${source.coverThumbUrl}|${source.icon}|${source.title}|${source.entryType}`;
      if (group.dataset.medallionSig !== sig) {
        // `graph-` prefix namespaces the <clipPath> id: SVG url(#…) hits the FIRST match in
        // the document, so a bare entry id would collide with the timeline's medallion.
        appendMedallionNode(group, { id: `graph-${d.id}`, radius: r, ...source });
        group.dataset.medallionSig = sig;
      }
    });

    // Click dispatch — shift+click pins, plain click navigates.
    nodeSel.on('click', (evt: MouseEvent, d) => {
      evt.stopPropagation();
      if (evt.shiftKey) {
        onPinNodeRef.current(d, d.x ?? 0, d.y ?? 0);
      } else {
        onNodeClickRef.current(d);
      }
    });

    // Hover → tooltip (position in client coords so the parent can place the
    // tooltip div absolutely within its own relative container).
    nodeSel
      .on('mouseenter', (evt: MouseEvent, d) => {
        const rect = svgRef.current!.getBoundingClientRect();
        onHoverNodeRef.current?.(d, evt.clientX - rect.left, evt.clientY - rect.top);
      })
      .on('mouseleave', () => {
        onHoverNodeRef.current?.(null, 0, 0);
      });

    // Simulation. alphaMin default (0.001) — d3 auto-stops.
    const linkDistance = Math.min(
      220,
      Math.max(120, Math.sqrt((width * height) / Math.max(nodes.length, 1)) * 0.55),
    );
    const sim: Simulation<SimNode, SimEdge> = forceSimulation<SimNode>(simNodes)
      .force(
        'link',
        forceLink<SimNode, SimEdge>(simEdges)
          .id((d) => d.id)
          .distance(linkDistance),
      )
      .force('charge', forceManyBody<SimNode>().strength(-Math.min(650, linkDistance * 2.5)))
      .force('center', forceCenter(width / 2, height / 2))
      .force('collide', forceCollide<SimNode>((d) => collisionRadiusOf(d.id)));

    // Drag — dual intent gated by editModeRef.current per the mirrored-ref
    // pattern. View-mode keeps the existing pin-and-position behavior; edit-
    // mode tracks the pointer for a link-creation preview edge and emits
    // lifecycle callbacks. Pin state (fx/fy) is NEVER touched in edit mode
    // so cancel/self-drop "snap-back" is a structural no-op (Pitfall 2).
    const dragBehavior = drag<SVGGElement, SimNode>()
      .on('start', (evt, d) => {
        if (editModeRef.current) {
          // Edit-mode drag: do NOT pin. Reset cancel flag, surface drag
          // source via React state for preview-edge mount, and notify parent.
          cancelledRef.current = false;
          setDragSource(d);
          setPointer({ x: evt.x, y: evt.y });
          onDragSourceChangeRef.current?.(d.id);
        } else {
          if (!evt.active) sim.alphaTarget(0.3).restart();
          d.fx = d.x;
          d.fy = d.y;
        }
      })
      .on('drag', (evt, d) => {
        if (editModeRef.current) {
          // Edit-mode drag: update the preview-edge endpoint in simulation
          // space (evt.x/y already account for zoom transform). Do NOT
          // touch d.fx/fy — the source node must not move during link drag.
          setPointer({ x: evt.x, y: evt.y });
        } else {
          d.fx = evt.x;
          d.fy = evt.y;
        }
      })
      .on('end', (evt, d) => {
        if (editModeRef.current) {
          // If the mid-drag Esc handler already fired the cancel path, skip
          // both onLinkDragEnd and onDragSourceChange(null) — those callbacks
          // ran when cancelledRef was set. The flag is reset on the next
          // 'start'.
          if (cancelledRef.current) {
            return;
          }
          // Phase 19 plan 19-02 task 1: surface the pointerup screen-space
          // coordinates so GraphView can subtract its container rect and
          // anchor the popover. Defensive defaults survive jsdom edge cases
          // where sourceEvent is undefined or lacks clientX/clientY.
          const se = evt.sourceEvent as MouseEvent | undefined;
          const dropClientX = typeof se?.clientX === 'number' ? se.clientX : 0;
          const dropClientY = typeof se?.clientY === 'number' ? se.clientY : 0;
          const target = hitTestNodeAt(evt.sourceEvent, simNodesRef.current);
          if (target === null) {
            onLinkDragEndRef.current(d, null, dropClientX, dropClientY);
          } else if (target.id === d.id) {
            onLinkDragEndRef.current(d, 'self', dropClientX, dropClientY);
          } else {
            onLinkDragEndRef.current(d, target, dropClientX, dropClientY);
          }
          setDragSource(null);
          setPointer(null);
          onDragSourceChangeRef.current?.(null);
        } else {
          if (!evt.active) sim.alphaTarget(0);
          // Release only if the node wasn't already pinned before dragging.
          if (!pinnedIds.has(d.id)) {
            d.fx = null;
            d.fy = null;
          }
        }
      });
    nodeSel.call(dragBehavior);

    // Zoom/pan on the root SVG; updates viewport <g> transform.
    const zoomBehavior: ZoomBehavior<SVGSVGElement, unknown> = zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.1, 4])
      .on('zoom', (evt) => {
        g.attr('transform', evt.transform.toString());
        // Keep overview text-free; titles and relationships appear only after zoom-in.
        g.selectAll<SVGTextElement, unknown>('text.node-label, text.edge-label')
          .attr('opacity', evt.transform.k < LABEL_VISIBLE_ZOOM ? 0 : 1);
      });
    // Swallow clicks-inside-zoom via the default; d3-zoom suppresses click
    // after a drag of > 3px automatically.
    svg.call(zoomBehavior);

    // Tick writer — reused by the tick listener AND called synchronously
    // after setup so the first paint already has correct positions (this
    // also means jsdom tests see the pinned fx/fy without waiting on the
    // internal d3 timer).
    const writePositions = () => {
      linkSel
        .attr('x1', (d) => (d.source as SimNode).x ?? 0)
        .attr('y1', (d) => (d.source as SimNode).y ?? 0)
        .attr('x2', (d) => (d.target as SimNode).x ?? 0)
        .attr('y2', (d) => (d.target as SimNode).y ?? 0);
      labelSel
        .attr('x', (d, index) => {
          const sx = (d.source as SimNode).x ?? 0;
          const tx = (d.target as SimNode).x ?? 0;
          const sy = (d.source as SimNode).y ?? 0;
          const ty = (d.target as SimNode).y ?? 0;
          const offset = 18 + (index % 4) * 8;
          return edgeLabelPosition({ x: sx, y: sy }, { x: tx, y: ty }, offset).x;
        })
        .attr('y', (d, index) => {
          const sy = (d.source as SimNode).y ?? 0;
          const ty = (d.target as SimNode).y ?? 0;
          const sx = (d.source as SimNode).x ?? 0;
          const tx = (d.target as SimNode).x ?? 0;
          const offset = 18 + (index % 4) * 8;
          return edgeLabelPosition({ x: sx, y: sy }, { x: tx, y: ty }, offset).y;
        });
      // One transform per node moves the disc, the art AND the label together.
      nodeSel.attr('transform', (d) => `translate(${d.x ?? 0}, ${d.y ?? 0})`);
      haloSel.attr('cx', (d) => d.x ?? 0).attr('cy', (d) => d.y ?? 0);
    };

    sim.on('tick', writePositions);
    // For pinned nodes, d.x/d.y are initialised from fx/fy during the first
    // forceLink pass inside forceSimulation(); synchronously run one tick
    // worth of positioning so the DOM reflects the pins immediately.
    sim.tick(1);
    writePositions();

    return () => {
      sim.stop();
      // Remove d3 listeners so unmount doesn't leak.
      svg.on('.zoom', null);
      nodeSel.on('click', null).on('mouseenter', null).on('mouseleave', null);
      nodeSel.on('.drag', null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodes, edges, positions, width, height, editMode, linkTypeRegistry, medallions]);

  // Mid-drag Esc cancel — window keydown listener installed only while a
  // drag is in flight. Removes the preview-edge, sets the cancelled flag so
  // the d3-drag `end` handler skips its emissions, and notifies the parent
  // exactly once that the drag-source is gone (UI-SPEC §G priority 3).
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
      width={width}
      height={height}
      className={[
        'block h-full w-full select-none',
        editMode ? 'cursor-crosshair' : '',
      ]
        .filter(Boolean)
        .join(' ')}
      data-testid="graph-canvas"
    >
      <g className="viewport">
        <g className="links" />
        <g className="edge-labels" />
        <g className="preview-edge">
          {dragSource && pointer && (
            <line
              data-testid="graph-preview-edge"
              x1={dragSource.x ?? 0}
              y1={dragSource.y ?? 0}
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
        <g className="halos" />
        <g className="nodes" />
      </g>
    </svg>
  );
}

/**
 * Hit-test the node under the pointer at pointerup. Uses
 * document.elementFromPoint (O(1), respects rendered z-order — halos and
 * preview-edge are pointer-events:none so the underlying node group is the
 * hit target). Returns the matching SimNode or null if no node is under the
 * pointer.
 *
 * The node is a <g data-node-id> whose children (medallion disc, cover image,
 * glyph, label) are what the pointer actually lands on — so the id is read
 * from the closest ancestor carrying it, whatever element that is.
 */
function hitTestNodeAt(
  sourceEvent: Event | undefined,
  simNodes: SimNode[],
): SimNode | null {
  if (!sourceEvent) return null;
  const me = sourceEvent as MouseEvent;
  if (typeof me.clientX !== 'number' || typeof me.clientY !== 'number') return null;
  const el = document.elementFromPoint(me.clientX, me.clientY);
  if (!el) return null;
  const group = (el as Element).closest('[data-node-id]');
  if (!group) return null;
  const id = group.getAttribute('data-node-id');
  if (!id) return null;
  return simNodes.find((n) => n.id === id) ?? null;
}
