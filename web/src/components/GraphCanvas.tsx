import { useEffect, useRef } from 'react';
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
import { zoom, type ZoomBehavior } from 'd3-zoom';
import type { GraphEdge, GraphNode, GraphPosition } from '../hooks/useGraphData';
import { entryTypeHexColor } from '../lib/entryTypeColor';

export interface GraphCanvasProps {
  nodes: GraphNode[];
  edges: GraphEdge[];
  positions: GraphPosition[];
  width: number;
  height: number;
  onNodeClick: (node: GraphNode) => void;
  onPinNode: (node: GraphNode, x: number, y: number) => void;
  onHoverNode?: (node: GraphNode | null, x: number, y: number) => void;
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
  label: string;
}

const NODE_RADIUS = 14;

export function GraphCanvas({
  nodes,
  edges,
  positions,
  width,
  height,
  onNodeClick,
  onPinNode,
  onHoverNode,
}: GraphCanvasProps) {
  const svgRef = useRef<SVGSVGElement>(null);
  // Latest callback refs so the useEffect doesn't need to re-run when the
  // parent re-renders with a new arrow function identity.
  const onNodeClickRef = useRef(onNodeClick);
  const onPinNodeRef = useRef(onPinNode);
  const onHoverNodeRef = useRef(onHoverNode);
  useEffect(() => {
    onNodeClickRef.current = onNodeClick;
    onPinNodeRef.current = onPinNode;
    onHoverNodeRef.current = onHoverNode;
  });

  useEffect(() => {
    if (!svgRef.current) return;

    // Build mutable copies — d3 mutates node.x/y. Mutating the original props
    // would break React's contract.
    const posMap = new Map(positions.map((p) => [p.entryId, p]));
    const simNodes: SimNode[] = nodes.map((n) => {
      const p = posMap.get(n.id);
      const copy: SimNode = { ...n };
      if (p) {
        copy.fx = p.x;
        copy.fy = p.y;
      }
      return copy;
    });
    const simEdges: SimEdge[] = edges.map((e) => ({
      id: e.id,
      source: e.source,
      target: e.target,
      label: e.label,
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
            .attr('stroke', '#6b7280')
            .attr('stroke-opacity', 0.7)
            .attr('stroke-width', 1.25),
        (update) => update,
        (exit) => exit.remove(),
      );

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
            .attr('text-anchor', 'middle')
            .attr('pointer-events', 'none')
            .text((d) => d.label),
        (update) => update.text((d) => d.label),
        (exit) => exit.remove(),
      );

    const nodeSel = g
      .select<SVGGElement>('g.nodes')
      .selectAll<SVGCircleElement, SimNode>('circle')
      .data(simNodes, (d) => d.id)
      .join(
        (enter) =>
          enter
            .append('circle')
            .attr('data-node-id', (d) => d.id)
            .attr('r', NODE_RADIUS)
            .attr('stroke', '#111827')
            .attr('stroke-width', 1)
            .style('cursor', 'pointer'),
        (update) => update,
        (exit) => exit.remove(),
      )
      .attr('fill', (d) => entryTypeHexColor(d.entryType));

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
    const sim: Simulation<SimNode, SimEdge> = forceSimulation<SimNode>(simNodes)
      .force(
        'link',
        forceLink<SimNode, SimEdge>(simEdges)
          .id((d) => d.id)
          .distance(90),
      )
      .force('charge', forceManyBody<SimNode>().strength(-220))
      .force('center', forceCenter(width / 2, height / 2))
      .force('collide', forceCollide<SimNode>(NODE_RADIUS + 4));

    // Drag — start pins, move updates fx/fy, end releases unless already pinned.
    const dragBehavior = drag<SVGCircleElement, SimNode>()
      .on('start', (evt, d) => {
        if (!evt.active) sim.alphaTarget(0.3).restart();
        d.fx = d.x;
        d.fy = d.y;
      })
      .on('drag', (evt, d) => {
        d.fx = evt.x;
        d.fy = evt.y;
      })
      .on('end', (evt, d) => {
        if (!evt.active) sim.alphaTarget(0);
        // Release only if the node wasn't already pinned before dragging.
        if (!pinnedIds.has(d.id)) {
          d.fx = null;
          d.fy = null;
        }
      });
    nodeSel.call(dragBehavior);

    // Zoom/pan on the root SVG; updates viewport <g> transform.
    const zoomBehavior: ZoomBehavior<SVGSVGElement, unknown> = zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.1, 4])
      .on('zoom', (evt) => {
        g.attr('transform', evt.transform.toString());
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
        .attr('x', (d) => {
          const sx = (d.source as SimNode).x ?? 0;
          const tx = (d.target as SimNode).x ?? 0;
          return (sx + tx) / 2;
        })
        .attr('y', (d) => {
          const sy = (d.source as SimNode).y ?? 0;
          const ty = (d.target as SimNode).y ?? 0;
          return (sy + ty) / 2;
        });
      nodeSel.attr('cx', (d) => d.x ?? 0).attr('cy', (d) => d.y ?? 0);
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
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodes, edges, positions, width, height]);

  return (
    <svg
      ref={svgRef}
      width={width}
      height={height}
      className="block h-full w-full select-none"
      data-testid="graph-canvas"
    >
      <g className="viewport">
        <g className="links" />
        <g className="edge-labels" />
        <g className="nodes" />
      </g>
    </svg>
  );
}
