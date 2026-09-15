import { afterEach, describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import { act } from 'react';
import { select } from 'd3-selection';
import { GraphCanvas, type GraphCanvasProps } from './GraphCanvas';
import type { GraphNode, GraphEdge, GraphPosition } from '../hooks/useGraphData';
import { NEUTRAL_EDGE_COLOR } from '../lib/linkTypeColor';
import { edgeLabelPosition, seededGraphPosition } from '../lib/graphLayout';

function makeNode(overrides: Partial<GraphNode> & { id: string }): GraphNode {
  return {
    id: overrides.id,
    title: overrides.title ?? `Node ${overrides.id}`,
    entryType: overrides.entryType ?? 'concept',
    summary: overrides.summary ?? '',
    icon: overrides.icon ?? '',
  };
}

function makeEdge(id: string, source: string, target: string, label: string | null = null): GraphEdge {
  return { id, source, target, label, linkType: null, direction: 'directed' };
}

function tinyGraph() {
  const nodes: GraphNode[] = [
    makeNode({ id: 'A', entryType: 'concept' }),
    makeNode({ id: 'B', entryType: 'location' }),
    makeNode({ id: 'C', entryType: 'faction' }),
  ];
  const edges: GraphEdge[] = [
    makeEdge('e1', 'A', 'B', 'lives-in'),
    makeEdge('e2', 'B', 'C'),
  ];
  const positions: GraphPosition[] = [];
  return { nodes, edges, positions };
}

// d3-drag listens for mousedown.drag on the selection, then attaches
// mousemove.drag / mouseup.drag to event.view (window). Tests must
// dispatch MouseEvents (not PointerEvents) — see d3-drag/src/drag.js.
//
// jsdom rejects MouseEventInit { view: window } as "not of type Window"
// but accepts the same property defined via Object.defineProperty AFTER
// construction. d3-drag calls `nodrag(event.view)` which reads
// `view.document` — so synthetic events without a view crash the
// handler silently. Override view post-construction.
function withView<T extends Event>(ev: T): T {
  Object.defineProperty(ev, 'view', { value: window, writable: false });
  return ev;
}

/**
 * Content-Forward Views §4: a node is a <g data-node-id> positioned by a single
 * `transform: translate(x, y)` (it holds a medallion + a label, so cx/cy no longer
 * describe where it sits). Throws rather than returning NaN so a missing transform
 * fails loudly instead of making a `.not.toBe()` assertion vacuously true.
 */
function translateOf(el: Element): { x: number; y: number } {
  const t = el.getAttribute('transform') ?? '';
  const m = /translate\(\s*([-\d.eE+]+)[ ,]+([-\d.eE+]+)\s*\)/.exec(t);
  if (!m) throw new Error(`expected a translate() transform, got ${JSON.stringify(t)}`);
  return { x: Number(m[1]), y: Number(m[2]) };
}

/**
 * Drive the component's OWN zoom behavior with a real wheel gesture — the only way to
 * exercise its 'zoom' listener (a `zoom().transform` call on a fresh behavior would stamp
 * the element's __zoom but never fire the component's handler, so the label fade would be
 * "tested" by a test that a no-op implementation also passes).
 *
 * d3-zoom's default extent reads `svg.width.baseVal.value`; jsdom leaves SVGAnimatedLength
 * unimplemented, so the gesture throws unless we stub the two lengths first.
 *
 * k' = k · 2^(-deltaY/500), so deltaY=1000 → k=0.25 (faded), deltaY=-1000 → back to k=1.
 */
function wheel(svg: SVGSVGElement, deltaY: number) {
  for (const dim of ['width', 'height'] as const) {
    if (!(svg[dim] as unknown as { baseVal?: unknown })?.baseVal) {
      Object.defineProperty(svg, dim, {
        value: { baseVal: { value: dim === 'width' ? 800 : 600 } },
        configurable: true,
      });
    }
  }
  act(() => {
    svg.dispatchEvent(
      withView(new WheelEvent('wheel', { deltaY, bubbles: true, cancelable: true })),
    );
  });
}

function dispatchPointerDown(circle: Element, clientX: number, clientY: number) {
  act(() => {
    circle.dispatchEvent(
      withView(
        new MouseEvent('mousedown', {
          bubbles: true,
          cancelable: true,
          clientX,
          clientY,
          button: 0,
        }),
      ),
    );
  });
}

function dispatchPointerMove(clientX: number, clientY: number) {
  act(() => {
    window.dispatchEvent(
      withView(
        new MouseEvent('mousemove', {
          bubbles: true,
          cancelable: true,
          clientX,
          clientY,
        }),
      ),
    );
  });
}

function dispatchPointerUp(clientX: number, clientY: number) {
  act(() => {
    window.dispatchEvent(
      withView(
        new MouseEvent('mouseup', {
          bubbles: true,
          cancelable: true,
          clientX,
          clientY,
        }),
      ),
    );
  });
}

function dispatchEscape() {
  act(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  });
}

// d3-drag installs a transient `click.drag` handler on the window selection
// after a drag of >3px (to swallow the trailing browser click). Its cleanup
// is queued via setTimeout(0) which doesn't always flush between Vitest
// tests, leaving the next test's click events silently preventDefault'd
// (manifests as a passing-in-isolation, failing-in-suite shift+click test).
// Restore the window selection deterministically between tests.
afterEach(() => {
  select(window).on('click.drag', null);
  select(window).on('mousemove.drag', null);
  select(window).on('mouseup.drag', null);
  select(window).on('dragstart.drag', null);
  select(window).on('selectstart.drag', null);
});

describe('GraphCanvas', () => {
  it('seeds unpinned nodes across the available canvas instead of a corner cluster', () => {
    const positions = Array.from({ length: 6 }, (_, index) =>
      seededGraphPosition(index, 6, 1200, 700),
    );

    expect(Math.min(...positions.map(({ x }) => x))).toBeGreaterThan(0);
    expect(Math.max(...positions.map(({ x }) => x))).toBeLessThan(1200);
    expect(Math.min(...positions.map(({ y }) => y))).toBeGreaterThan(0);
    expect(Math.max(...positions.map(({ y }) => y))).toBeLessThan(700);
    expect(new Set(positions.map(({ x }) => x)).size).toBeGreaterThan(1);
    expect(new Set(positions.map(({ y }) => y)).size).toBeGreaterThan(1);
  });

  it('places an edge label off the connecting line for readable separation', () => {
    const point = edgeLabelPosition({ x: 100, y: 100 }, { x: 300, y: 100 });

    expect(point.x).toBeCloseTo(200);
    expect(point.y).not.toBeCloseTo(100);
  });

  it('renders one node group per node and one line per edge', () => {
    const { nodes, edges, positions } = tinyGraph();
    const { container } = render(
      <GraphCanvas
        nodes={nodes}
        edges={edges}
        positions={positions}
        width={600}
        height={400}
        onNodeClick={vi.fn()}
        onPinNode={vi.fn()}
        editMode={false}
        onLinkDragEnd={vi.fn()}
      />,
    );
    expect(container.querySelectorAll('g.nodes g[data-node-id]')).toHaveLength(3);
    expect(container.querySelectorAll('g.links line')).toHaveLength(2);
  });

  // Content-Forward Views §4: the entry-type hue moved from the node circle's FILL to the
  // medallion disc's ring STROKE — the fill is now that same hue at 18% opacity, because a
  // cover portrait has to show through the disc it is framed by.
  it('rings each medallion disc with its entryType color from entryTypeHexColor', () => {
    const { nodes, edges, positions } = tinyGraph();
    const { container } = render(
      <GraphCanvas
        nodes={nodes}
        edges={edges}
        positions={positions}
        width={600}
        height={400}
        onNodeClick={vi.fn()}
        onPinNode={vi.fn()}
        editMode={false}
        onLinkDragEnd={vi.fn()}
      />,
    );
    const discs = Array.from(container.querySelectorAll('g.nodes circle.medallion-disc'));
    expect(discs).toHaveLength(3);
    const strokes = discs.map((c) => c.getAttribute('stroke'));
    expect(strokes).toContain('#3b82f6');
    expect(strokes).toContain('#f59e0b');
    expect(strokes).toContain('#a855f7');
    // The hue still tints the disc itself, just translucently.
    for (const disc of discs) {
      expect(disc.getAttribute('fill')).toBe(disc.getAttribute('stroke'));
    }
  });

  it('renders edge labels for edges that have a label, hidden at overview scale', () => {
    const { nodes, edges, positions } = tinyGraph();
    const { container } = render(
      <GraphCanvas
        nodes={nodes}
        edges={edges}
        positions={positions}
        width={600}
        height={400}
        onNodeClick={vi.fn()}
        onPinNode={vi.fn()}
        editMode={false}
        onLinkDragEnd={vi.fn()}
      />,
    );
    const labels = Array.from(container.querySelectorAll('text.edge-label'));
    expect(labels.map((n) => n.textContent)).toContain('lives-in');
    expect(labels).toHaveLength(1);
    expect(labels[0].getAttribute('opacity')).toBe('0');
    expect(labels[0].getAttribute('paint-order')).toBe('stroke');
    expect(labels[0].getAttribute('stroke-width')).toBe('5');
  });

  it('strokes untyped edges with NEUTRAL_EDGE_COLOR (SC#3 backward-compat)', () => {
    const { nodes, edges, positions } = tinyGraph();
    const { container } = render(
      <GraphCanvas
        nodes={nodes}
        edges={edges}
        positions={positions}
        width={600}
        height={400}
        onNodeClick={vi.fn()}
        onPinNode={vi.fn()}
        editMode={false}
        onLinkDragEnd={vi.fn()}
        // no linkTypeRegistry → defaults to {} → untyped edges → NEUTRAL_EDGE_COLOR
      />,
    );
    const lines = Array.from(container.querySelectorAll('g.links line'));
    expect(lines.length).toBeGreaterThan(0);
    // All edges in tinyGraph are untyped (linkType: null) — must resolve to NEUTRAL_EDGE_COLOR
    for (const line of lines) {
      expect(line.getAttribute('stroke')).toBe(NEUTRAL_EDGE_COLOR);
    }
  });

  it('strokes a typed edge with the preset/hash color from getLinkTypeColor', () => {
    const nodes = [
      { id: 'A', title: 'A', entryType: 'concept', summary: '', icon: '' } as GraphNode,
      { id: 'B', title: 'B', entryType: 'location', summary: '', icon: '' } as GraphNode,
    ];
    const edges: GraphEdge[] = [
      { id: 'e1', source: 'A', target: 'B', label: null, linkType: 'ally_of', direction: 'undirected' },
    ];
    const { container } = render(
      <GraphCanvas
        nodes={nodes}
        edges={edges}
        positions={[]}
        width={600}
        height={400}
        onNodeClick={vi.fn()}
        onPinNode={vi.fn()}
        editMode={false}
        onLinkDragEnd={vi.fn()}
      />,
    );
    const line = container.querySelector('g.links line') as SVGLineElement;
    expect(line).toBeTruthy();
    // 'ally_of' preset color is '#06b6d4'
    expect(line.getAttribute('stroke')).toBe('#06b6d4');
  });

  it('fires onNodeClick when a node is clicked without modifier', () => {
    const { nodes, edges, positions } = tinyGraph();
    const onNodeClick = vi.fn();
    const onPinNode = vi.fn();
    const { container } = render(
      <GraphCanvas
        nodes={nodes}
        edges={edges}
        positions={positions}
        width={600}
        height={400}
        onNodeClick={onNodeClick}
        onPinNode={onPinNode}
        editMode={false}
        onLinkDragEnd={vi.fn()}
      />,
    );
    const node = container.querySelectorAll('g.nodes g[data-node-id]')[0] as SVGGElement;
    node.dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: false }));
    expect(onNodeClick).toHaveBeenCalledTimes(1);
    expect(onPinNode).not.toHaveBeenCalled();
    expect(onNodeClick.mock.calls[0][0]).toMatchObject({ id: 'A' });
  });

  it('fires onPinNode when a node is shift+clicked', () => {
    const { nodes, edges, positions } = tinyGraph();
    const onNodeClick = vi.fn();
    const onPinNode = vi.fn();
    const { container } = render(
      <GraphCanvas
        nodes={nodes}
        edges={edges}
        positions={positions}
        width={600}
        height={400}
        onNodeClick={onNodeClick}
        onPinNode={onPinNode}
        editMode={false}
        onLinkDragEnd={vi.fn()}
      />,
    );
    const node = container.querySelectorAll('g.nodes g[data-node-id]')[1] as SVGGElement;
    node.dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true }));
    expect(onPinNode).toHaveBeenCalledTimes(1);
    expect(onNodeClick).not.toHaveBeenCalled();
    expect(onPinNode.mock.calls[0][0]).toMatchObject({ id: 'B' });
  });

  it('respects the positions array by pinning fx/fy so those nodes stay put', () => {
    const nodes: GraphNode[] = [makeNode({ id: 'A' }), makeNode({ id: 'B' })];
    const edges: GraphEdge[] = [makeEdge('e1', 'A', 'B')];
    const positions: GraphPosition[] = [{ entryId: 'A', x: 150, y: 250 }];
    const { container } = render(
      <GraphCanvas
        nodes={nodes}
        edges={edges}
        positions={positions}
        width={800}
        height={600}
        onNodeClick={vi.fn()}
        onPinNode={vi.fn()}
        editMode={false}
        onLinkDragEnd={vi.fn()}
      />,
    );
    const a = container.querySelector('g.nodes g[data-node-id="A"]');
    expect(a).toBeTruthy();
    expect(translateOf(a!).x).toBeCloseTo(150, 0);
    expect(translateOf(a!).y).toBeCloseTo(250, 0);
  });

  // ---------- Phase 19 edit-mode tests ----------

  describe('edit mode — halo + cursor (GRAPH-01)', () => {
    it('Test A: renders one halo circle per visible node in g.halos when editMode=true', () => {
      const { nodes, edges, positions } = tinyGraph();
      const { container } = render(
        <GraphCanvas
          nodes={nodes}
          edges={edges}
          positions={positions}
          width={600}
          height={400}
          onNodeClick={vi.fn()}
          onPinNode={vi.fn()}
          editMode={true}
          onLinkDragEnd={vi.fn()}
        />,
      );
      const halos = container.querySelectorAll('g.halos circle');
      expect(halos).toHaveLength(3);
      // Halo has data-halo-id and pointer-events none
      const first = halos[0] as SVGCircleElement;
      expect(first.getAttribute('data-halo-id')).toBeTruthy();
      expect(first.getAttribute('pointer-events')).toBe('none');
    });

    it('Test A (cont.): g.halos group exists but is empty when editMode=false', () => {
      const { nodes, edges, positions } = tinyGraph();
      const { container } = render(
        <GraphCanvas
          nodes={nodes}
          edges={edges}
          positions={positions}
          width={600}
          height={400}
          onNodeClick={vi.fn()}
          onPinNode={vi.fn()}
          editMode={false}
          onLinkDragEnd={vi.fn()}
        />,
      );
      expect(container.querySelector('g.halos')).toBeTruthy();
      expect(container.querySelectorAll('g.halos circle')).toHaveLength(0);
    });

    it('Test B: root <svg> has cursor-crosshair class when editMode=true', () => {
      const { nodes, edges, positions } = tinyGraph();
      const { container } = render(
        <GraphCanvas
          nodes={nodes}
          edges={edges}
          positions={positions}
          width={600}
          height={400}
          onNodeClick={vi.fn()}
          onPinNode={vi.fn()}
          editMode={true}
          onLinkDragEnd={vi.fn()}
        />,
      );
      const svg = container.querySelector('svg');
      expect(svg?.getAttribute('class')).toMatch(/cursor-crosshair/);
    });

    it('Test B (cont.): root <svg> does NOT have cursor-crosshair class when editMode=false', () => {
      const { nodes, edges, positions } = tinyGraph();
      const { container } = render(
        <GraphCanvas
          nodes={nodes}
          edges={edges}
          positions={positions}
          width={600}
          height={400}
          onNodeClick={vi.fn()}
          onPinNode={vi.fn()}
          editMode={false}
          onLinkDragEnd={vi.fn()}
        />,
      );
      const svg = container.querySelector('svg');
      expect(svg?.getAttribute('class') ?? '').not.toMatch(/cursor-crosshair/);
    });
  });

  describe('edit mode — preview edge (GRAPH-02)', () => {
    it('Test C: pointerdown on a node mounts the preview-edge line in g.preview-edge', () => {
      const { nodes, edges, positions } = tinyGraph();
      const { container } = render(
        <GraphCanvas
          nodes={nodes}
          edges={edges}
          positions={positions}
          width={600}
          height={400}
          onNodeClick={vi.fn()}
          onPinNode={vi.fn()}
          editMode={true}
          onLinkDragEnd={vi.fn()}
        />,
      );
      // Before drag: no preview edge
      expect(container.querySelector('[data-testid="graph-preview-edge"]')).toBeNull();

      const nodeA = container.querySelector(
        'g.nodes g[data-node-id="A"]',
      ) as SVGGElement;
      const rect = nodeA.getBoundingClientRect();
      dispatchPointerDown(nodeA, rect.left + rect.width / 2, rect.top + rect.height / 2);

      const preview = container.querySelector('[data-testid="graph-preview-edge"]');
      expect(preview).toBeTruthy();
      expect(preview?.parentElement?.getAttribute('class')).toMatch(/preview-edge/);

      // Cleanup: end the drag so subsequent tests do not leak
      dispatchPointerUp(rect.left, rect.top);
    });

    it('Test D: preview-edge x2/y2 track pointer position during drag', () => {
      const { nodes, edges, positions } = tinyGraph();
      const { container } = render(
        <GraphCanvas
          nodes={nodes}
          edges={edges}
          positions={positions}
          width={600}
          height={400}
          onNodeClick={vi.fn()}
          onPinNode={vi.fn()}
          editMode={true}
          onLinkDragEnd={vi.fn()}
        />,
      );
      const nodeA = container.querySelector(
        'g.nodes g[data-node-id="A"]',
      ) as SVGGElement;
      const aRect = nodeA.getBoundingClientRect();
      dispatchPointerDown(nodeA, aRect.left + aRect.width / 2, aRect.top + aRect.height / 2);
      dispatchPointerMove(aRect.left + 100, aRect.top + 50);

      const preview = container.querySelector('[data-testid="graph-preview-edge"]') as SVGLineElement;
      expect(preview).toBeTruthy();
      // d3-drag's evt.x/y are simulation-space; after a move event x2/y2 should
      // have changed from the initial drag-start pointer position. We assert
      // x2 and y2 are non-null (the preview-edge is rendered with both coords
      // sourced from React state).
      expect(preview.getAttribute('x2')).not.toBeNull();
      expect(preview.getAttribute('y2')).not.toBeNull();
      // x2 should differ from the starting simulation-space coordinate of nodeA.
      // (The node is a <g> now: its position lives in the group transform, not cx/cy.)
      const ax = translateOf(nodeA).x;
      expect(Number(preview.getAttribute('x2'))).not.toBe(ax);

      dispatchPointerUp(aRect.left + 100, aRect.top + 50);
    });
  });

  describe('edit mode — drop outcomes (GRAPH-02 + GRAPH-05)', () => {
    it('Test E: pointerup on a different node calls onLinkDragEnd(from, target)', () => {
      const { nodes, edges, positions } = tinyGraph();
      const onLinkDragEnd = vi.fn();
      const { container } = render(
        <GraphCanvas
          nodes={nodes}
          edges={edges}
          positions={positions}
          width={600}
          height={400}
          onNodeClick={vi.fn()}
          onPinNode={vi.fn()}
          editMode={true}
          onLinkDragEnd={onLinkDragEnd}
        />,
      );
      const nodeA = container.querySelector(
        'g.nodes g[data-node-id="A"]',
      ) as SVGGElement;
      const nodeB = container.querySelector(
        'g.nodes g[data-node-id="B"]',
      ) as SVGGElement;
      const aRect = nodeA.getBoundingClientRect();
      const bRect = nodeB.getBoundingClientRect();

      vi.spyOn(document, 'elementFromPoint').mockReturnValue(
        // A real browser returns the TOPMOST element under the pointer — the medallion disc,
        // never the <g> that carries data-node-id. hitTestNodeAt must walk up to it.
        nodeB.querySelector('circle.medallion-disc')!,
      );

      const dropX = bRect.left + bRect.width / 2;
      const dropY = bRect.top + bRect.height / 2;
      dispatchPointerDown(nodeA, aRect.left + aRect.width / 2, aRect.top + aRect.height / 2);
      dispatchPointerMove(dropX, dropY);
      dispatchPointerUp(dropX, dropY);

      expect(onLinkDragEnd).toHaveBeenCalledTimes(1);
      expect(onLinkDragEnd.mock.calls[0][0]).toMatchObject({ id: 'A' });
      expect(onLinkDragEnd.mock.calls[0][1]).toMatchObject({ id: 'B' });
      // Phase 19 plan 19-02 task 1: extended signature carries the drop
      // screen-space coordinates so GraphView can position the popover.
      expect(onLinkDragEnd.mock.calls[0][2]).toBeCloseTo(dropX);
      expect(onLinkDragEnd.mock.calls[0][3]).toBeCloseTo(dropY);
    });

    it("Test F: pointerup on the source node calls onLinkDragEnd(from, 'self')", () => {
      const { nodes, edges, positions } = tinyGraph();
      const onLinkDragEnd = vi.fn();
      const { container } = render(
        <GraphCanvas
          nodes={nodes}
          edges={edges}
          positions={positions}
          width={600}
          height={400}
          onNodeClick={vi.fn()}
          onPinNode={vi.fn()}
          editMode={true}
          onLinkDragEnd={onLinkDragEnd}
        />,
      );
      const nodeA = container.querySelector(
        'g.nodes g[data-node-id="A"]',
      ) as SVGGElement;
      const aRect = nodeA.getBoundingClientRect();

      vi.spyOn(document, 'elementFromPoint').mockReturnValue(
        // A real browser returns the TOPMOST element under the pointer — the medallion disc,
        // never the <g> that carries data-node-id. hitTestNodeAt must walk up to it.
        nodeA.querySelector('circle.medallion-disc')!,
      );

      const dropX = aRect.left + aRect.width / 2 + 6;
      const dropY = aRect.top + aRect.height / 2 + 6;
      dispatchPointerDown(nodeA, aRect.left + aRect.width / 2, aRect.top + aRect.height / 2);
      // No move beyond 5px so it counts as click-ish but pointerup still triggers end
      dispatchPointerMove(dropX, dropY);
      dispatchPointerUp(dropX, dropY);

      expect(onLinkDragEnd).toHaveBeenCalledTimes(1);
      expect(onLinkDragEnd.mock.calls[0][0]).toMatchObject({ id: 'A' });
      expect(onLinkDragEnd.mock.calls[0][1]).toBe('self');
      // Phase 19 plan 19-02 task 1: drop coordinates surface even on 'self'.
      expect(onLinkDragEnd.mock.calls[0][2]).toBeCloseTo(dropX);
      expect(onLinkDragEnd.mock.calls[0][3]).toBeCloseTo(dropY);
    });

    it('Test G: pointerup on empty canvas calls onLinkDragEnd(from, null)', () => {
      const { nodes, edges, positions } = tinyGraph();
      const onLinkDragEnd = vi.fn();
      const { container } = render(
        <GraphCanvas
          nodes={nodes}
          edges={edges}
          positions={positions}
          width={600}
          height={400}
          onNodeClick={vi.fn()}
          onPinNode={vi.fn()}
          editMode={true}
          onLinkDragEnd={onLinkDragEnd}
        />,
      );
      const nodeA = container.querySelector(
        'g.nodes g[data-node-id="A"]',
      ) as SVGGElement;
      const aRect = nodeA.getBoundingClientRect();

      vi.spyOn(document, 'elementFromPoint').mockReturnValue(null);

      const dropX = aRect.left + 200;
      const dropY = aRect.top + 200;
      dispatchPointerDown(nodeA, aRect.left + aRect.width / 2, aRect.top + aRect.height / 2);
      dispatchPointerMove(dropX, dropY);
      dispatchPointerUp(dropX, dropY);

      expect(onLinkDragEnd).toHaveBeenCalledTimes(1);
      expect(onLinkDragEnd.mock.calls[0][0]).toMatchObject({ id: 'A' });
      expect(onLinkDragEnd.mock.calls[0][1]).toBeNull();
      // Phase 19 plan 19-02 task 1: drop coordinates still surface on empty.
      expect(onLinkDragEnd.mock.calls[0][2]).toBeCloseTo(dropX);
      expect(onLinkDragEnd.mock.calls[0][3]).toBeCloseTo(dropY);
    });
  });

  describe('edit mode — mid-drag Esc cancel (GRAPH-04)', () => {
    it('Test H: Escape mid-drag removes preview edge and prevents onLinkDragEnd from firing', () => {
      const { nodes, edges, positions } = tinyGraph();
      const onLinkDragEnd = vi.fn();
      const { container } = render(
        <GraphCanvas
          nodes={nodes}
          edges={edges}
          positions={positions}
          width={600}
          height={400}
          onNodeClick={vi.fn()}
          onPinNode={vi.fn()}
          editMode={true}
          onLinkDragEnd={onLinkDragEnd}
        />,
      );
      const nodeA = container.querySelector(
        'g.nodes g[data-node-id="A"]',
      ) as SVGGElement;
      const nodeB = container.querySelector(
        'g.nodes g[data-node-id="B"]',
      ) as SVGGElement;
      const aRect = nodeA.getBoundingClientRect();
      const bRect = nodeB.getBoundingClientRect();
      vi.spyOn(document, 'elementFromPoint').mockReturnValue(
        // A real browser returns the TOPMOST element under the pointer — the medallion disc,
        // never the <g> that carries data-node-id. hitTestNodeAt must walk up to it.
        nodeB.querySelector('circle.medallion-disc')!,
      );

      dispatchPointerDown(nodeA, aRect.left + aRect.width / 2, aRect.top + aRect.height / 2);
      dispatchPointerMove(bRect.left, bRect.top);
      // Preview edge mounted
      expect(container.querySelector('[data-testid="graph-preview-edge"]')).toBeTruthy();

      dispatchEscape();
      // Preview edge gone
      expect(container.querySelector('[data-testid="graph-preview-edge"]')).toBeNull();

      // Now the eventual pointerup must NOT fire onLinkDragEnd
      dispatchPointerUp(bRect.left, bRect.top);
      expect(onLinkDragEnd).not.toHaveBeenCalled();
    });

    it('Test I: Esc cancel on a pre-pinned node leaves its fx/fy intact (pre-drag pin state)', () => {
      const nodes: GraphNode[] = [makeNode({ id: 'A' }), makeNode({ id: 'B' })];
      const edges: GraphEdge[] = [makeEdge('e1', 'A', 'B')];
      const positions: GraphPosition[] = [{ entryId: 'A', x: 150, y: 250 }];
      const { container } = render(
        <GraphCanvas
          nodes={nodes}
          edges={edges}
          positions={positions}
          width={800}
          height={600}
          onNodeClick={vi.fn()}
          onPinNode={vi.fn()}
          editMode={true}
          onLinkDragEnd={vi.fn()}
        />,
      );
      const nodeA = container.querySelector(
        'g.nodes g[data-node-id="A"]',
      ) as SVGGElement;
      const transformBefore = nodeA.getAttribute('transform');

      const aRect = nodeA.getBoundingClientRect();
      vi.spyOn(document, 'elementFromPoint').mockReturnValue(null);
      dispatchPointerDown(nodeA, aRect.left, aRect.top);
      dispatchPointerMove(aRect.left + 100, aRect.top + 100);
      dispatchEscape();

      // Pin state preserved structurally — edit-mode drag never mutated fx/fy.
      // Assert via the group transform still matching the pinned coordinates.
      expect(nodeA.getAttribute('transform')).toBe(transformBefore);
      expect(translateOf(nodeA).x).toBeCloseTo(150, 0);
      expect(translateOf(nodeA).y).toBeCloseTo(250, 0);
    });
  });

  describe('edit mode — view-mode regression (Pitfall 2)', () => {
    it('Test J: shift+click still pins in view mode (existing behavior preserved)', () => {
      const { nodes, edges, positions } = tinyGraph();
      const onPinNode = vi.fn();
      const { container } = render(
        <GraphCanvas
          nodes={nodes}
          edges={edges}
          positions={positions}
          width={600}
          height={400}
          onNodeClick={vi.fn()}
          onPinNode={onPinNode}
          editMode={false}
          onLinkDragEnd={vi.fn()}
        />,
      );
      const node = container.querySelector(
        'g.nodes g[data-node-id="B"]',
      ) as SVGGElement;
      node.dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true }));
      expect(onPinNode).toHaveBeenCalledTimes(1);
      expect(onPinNode.mock.calls[0][0]).toMatchObject({ id: 'B' });
    });
  });

  describe('edit mode — subgraph idempotence (Pitfall 4)', () => {
    it('Test K: empty nodes + editMode=true → g.halos exists with 0 children', () => {
      const { container } = render(
        <GraphCanvas
          nodes={[]}
          edges={[]}
          positions={[]}
          width={600}
          height={400}
          onNodeClick={vi.fn()}
          onPinNode={vi.fn()}
          editMode={true}
          onLinkDragEnd={vi.fn()}
        />,
      );
      const halosGroup = container.querySelector('g.halos');
      expect(halosGroup).toBeTruthy();
      expect(halosGroup?.querySelectorAll('circle')).toHaveLength(0);
    });
  });

  describe('edit mode — onDragSourceChange lifecycle', () => {
    it('Test L: fires exactly once with sourceId on pointerdown and once with null on pointerup', () => {
      const { nodes, edges, positions } = tinyGraph();
      const onDragSourceChange = vi.fn();
      const { container } = render(
        <GraphCanvas
          nodes={nodes}
          edges={edges}
          positions={positions}
          width={600}
          height={400}
          onNodeClick={vi.fn()}
          onPinNode={vi.fn()}
          editMode={true}
          onLinkDragEnd={vi.fn()}
          onDragSourceChange={onDragSourceChange}
        />,
      );
      const nodeA = container.querySelector(
        'g.nodes g[data-node-id="A"]',
      ) as SVGGElement;
      const nodeB = container.querySelector(
        'g.nodes g[data-node-id="B"]',
      ) as SVGGElement;
      const aRect = nodeA.getBoundingClientRect();
      const bRect = nodeB.getBoundingClientRect();
      vi.spyOn(document, 'elementFromPoint').mockReturnValue(
        // A real browser returns the TOPMOST element under the pointer — the medallion disc,
        // never the <g> that carries data-node-id. hitTestNodeAt must walk up to it.
        nodeB.querySelector('circle.medallion-disc')!,
      );

      dispatchPointerDown(nodeA, aRect.left + aRect.width / 2, aRect.top + aRect.height / 2);
      expect(onDragSourceChange).toHaveBeenCalledTimes(1);
      expect(onDragSourceChange.mock.calls[0][0]).toBe('A');

      dispatchPointerMove(bRect.left, bRect.top);
      // Should NOT fire on move
      expect(onDragSourceChange).toHaveBeenCalledTimes(1);

      dispatchPointerUp(bRect.left + bRect.width / 2, bRect.top + bRect.height / 2);
      expect(onDragSourceChange).toHaveBeenCalledTimes(2);
      expect(onDragSourceChange.mock.calls[1][0]).toBeNull();
    });

    it('Test M: Esc cancel fires onDragSourceChange(null); trailing pointerup does NOT re-fire', () => {
      const { nodes, edges, positions } = tinyGraph();
      const onDragSourceChange = vi.fn();
      const { container } = render(
        <GraphCanvas
          nodes={nodes}
          edges={edges}
          positions={positions}
          width={600}
          height={400}
          onNodeClick={vi.fn()}
          onPinNode={vi.fn()}
          editMode={true}
          onLinkDragEnd={vi.fn()}
          onDragSourceChange={onDragSourceChange}
        />,
      );
      const nodeA = container.querySelector(
        'g.nodes g[data-node-id="A"]',
      ) as SVGGElement;
      const aRect = nodeA.getBoundingClientRect();

      dispatchPointerDown(nodeA, aRect.left + aRect.width / 2, aRect.top + aRect.height / 2);
      expect(onDragSourceChange).toHaveBeenCalledTimes(1);
      expect(onDragSourceChange.mock.calls[0][0]).toBe('A');

      dispatchPointerMove(aRect.left + 50, aRect.top + 50);
      dispatchEscape();
      expect(onDragSourceChange).toHaveBeenCalledTimes(2);
      expect(onDragSourceChange.mock.calls[1][0]).toBeNull();

      // Trailing pointerup after cancel MUST NOT add a third call.
      dispatchPointerUp(aRect.left + 50, aRect.top + 50);
      expect(onDragSourceChange).toHaveBeenCalledTimes(2);
    });

    it('Test N: editMode=false → onDragSourceChange is NOT called', () => {
      const { nodes, edges, positions } = tinyGraph();
      const onDragSourceChange = vi.fn();
      const { container } = render(
        <GraphCanvas
          nodes={nodes}
          edges={edges}
          positions={positions}
          width={600}
          height={400}
          onNodeClick={vi.fn()}
          onPinNode={vi.fn()}
          editMode={false}
          onLinkDragEnd={vi.fn()}
          onDragSourceChange={onDragSourceChange}
        />,
      );
      const nodeA = container.querySelector(
        'g.nodes g[data-node-id="A"]',
      ) as SVGGElement;
      const aRect = nodeA.getBoundingClientRect();
      dispatchPointerDown(nodeA, aRect.left, aRect.top);
      dispatchPointerMove(aRect.left + 20, aRect.top + 20);
      dispatchPointerUp(aRect.left + 20, aRect.top + 20);
      expect(onDragSourceChange).not.toHaveBeenCalled();
    });

    it('Test O: omitting onDragSourceChange does not throw on any drag lifecycle event', () => {
      const { nodes, edges, positions } = tinyGraph();
      const { container } = render(
        <GraphCanvas
          nodes={nodes}
          edges={edges}
          positions={positions}
          width={600}
          height={400}
          onNodeClick={vi.fn()}
          onPinNode={vi.fn()}
          editMode={true}
          onLinkDragEnd={vi.fn()}
          // onDragSourceChange omitted
        />,
      );
      const nodeA = container.querySelector(
        'g.nodes g[data-node-id="A"]',
      ) as SVGGElement;
      const aRect = nodeA.getBoundingClientRect();
      vi.spyOn(document, 'elementFromPoint').mockReturnValue(null);
      expect(() => {
        dispatchPointerDown(nodeA, aRect.left, aRect.top);
        dispatchPointerMove(aRect.left + 30, aRect.top + 30);
        dispatchEscape();
        dispatchPointerUp(aRect.left + 30, aRect.top + 30);
      }).not.toThrow();
    });
  });

  describe('Content-Forward Views §4 — medallion nodes', () => {
    function renderGraph(extra: Partial<GraphCanvasProps> = {}) {
      const { nodes, edges, positions } = tinyGraph();
      return render(
        <GraphCanvas
          nodes={nodes}
          edges={edges}
          positions={positions}
          width={800}
          height={600}
          onNodeClick={() => {}}
          onPinNode={() => {}}
          editMode={false}
          onLinkDragEnd={() => {}}
          {...extra}
        />,
      );
    }

    it('renders each node as a <g data-node-id> group containing a medallion disc', () => {
      const { container } = renderGraph();
      expect(container.querySelectorAll('g.nodes g[data-node-id]')).toHaveLength(3);
      expect(container.querySelectorAll('g.nodes circle.medallion-disc')).toHaveLength(3);
    });

    it('renders a clipped cover image for nodes that have one, and a monogram otherwise', () => {
      const medallions = new Map([
        ['A', { title: 'Aldric', entryType: 'entity', icon: '', coverThumbUrl: '/thumb-a.png' }],
        ['B', { title: 'Bare', entryType: 'location', icon: '', coverThumbUrl: null }],
      ]);
      const { container } = renderGraph({ medallions });
      const a = container.querySelector('g[data-node-id="A"]')!;
      const b = container.querySelector('g[data-node-id="B"]')!;
      expect(a.querySelector('image')?.getAttribute('href')).toBe('/thumb-a.png');
      expect(b.querySelector('image')).toBeNull();
      expect(b.querySelector('text.medallion-glyph')?.textContent).toBe('B');
    });

    it('namespaces the clipPath id per surface, so two SVG surfaces cannot collide', () => {
      // SVG url(#…) resolves to the FIRST matching id in the document. A bare entry id
      // would collide with the timeline's medallion for the same entry.
      const medallions = new Map([
        ['A', { title: 'Aldric', entryType: 'entity', icon: '', coverThumbUrl: '/thumb-a.png' }],
      ]);
      const { container } = renderGraph({ medallions });
      expect(container.querySelector('clipPath#medallion-clip-graph-A')).toBeTruthy();
    });

    it('renders a title label beneath every node, hidden at overview scale', () => {
      const { container } = renderGraph();
      const labels = Array.from(container.querySelectorAll('text.node-label')).map((t) => t.textContent);
      expect(labels).toHaveLength(3);
      expect(labels).toContain('Node A');
      expect(labels).toContain('Node B');
      expect(container.querySelector('text.node-label')?.getAttribute('opacity')).toBe('0');
    });

    it('keeps the label after a re-render — appendMedallionNode must not purge it', () => {
      // appendMedallionNode re-runs on the merged enter+update selection on every data
      // change and purges what IT appended. The label is appended alongside it, so a purge
      // that reached too far would silently strip every title on the second render.
      const { nodes, edges, positions } = tinyGraph();
      const props = {
        nodes,
        edges,
        positions,
        width: 800,
        height: 600,
        onNodeClick: () => {},
        onPinNode: () => {},
        editMode: false,
        onLinkDragEnd: () => {},
      };
      const { container, rerender } = render(<GraphCanvas {...props} />);
      rerender(<GraphCanvas {...props} positions={[{ entryId: 'A', x: 10, y: 20 }]} />);
      expect(container.querySelectorAll('text.node-label')).toHaveLength(3);
      // …and exactly one label per node, not a duplicate stacked on each re-render.
      expect(
        container.querySelectorAll('g[data-node-id="A"] text.node-label'),
      ).toHaveLength(1);
      expect(container.querySelectorAll('g.nodes circle.medallion-disc')).toHaveLength(3);
    });

    it('scales the edit-mode halo with the node, so a hub is still ringed', () => {
      // Discs range 14–26 but the halo used to be a fixed 18 — on a hub the halo was buried
      // inside the medallion and edit mode lost its affordance on the most-linked nodes.
      const { container } = renderGraph({ editMode: true });
      const haloR = Number(container.querySelector('g.halos circle[data-halo-id="B"]')!.getAttribute('r'));
      const discR = Number(container.querySelector('g[data-node-id="B"] circle.medallion-disc')!.getAttribute('r'));
      expect(haloR).toBeGreaterThan(discR);
    });

    it('shows node and edge labels only after zooming in', () => {
      // Driven through a REAL wheel gesture on the component's own zoom behavior. Calling
      // `zoom().transform` from a fresh behavior would stamp __zoom but never invoke the
      // component's 'zoom' listener — the fade would be untested and the test would pass on
      // a no-op implementation.
      const { container } = renderGraph();
      const svg = container.querySelector('svg') as SVGSVGElement;
      const labelOpacity = (selector: string) =>
        container.querySelector(selector)!.getAttribute('opacity');

      expect(labelOpacity('text.node-label')).toBe('0');
      expect(labelOpacity('text.edge-label')).toBe('0');
      wheel(svg, -500); // k = 2 → above LABEL_VISIBLE_ZOOM
      expect(labelOpacity('text.node-label')).toBe('1');
      expect(labelOpacity('text.edge-label')).toBe('1');
      wheel(svg, 500); // back to k = 1
      expect(labelOpacity('text.node-label')).toBe('0');
      expect(labelOpacity('text.edge-label')).toBe('0');
    });

    it('enters new labels hidden when the canvas is at overview scale', () => {
      // Labels are otherwise only ever repainted by the zoom handler, so a node arriving
      // while zoomed out would paint at full opacity beside its faded neighbours.
      const { nodes, edges, positions } = tinyGraph();
      const props = {
        nodes,
        edges,
        positions,
        width: 800,
        height: 600,
        onNodeClick: () => {},
        onPinNode: () => {},
        editMode: false,
        onLinkDragEnd: () => {},
      };
      const { container, rerender } = render(<GraphCanvas {...props} />);
      // A re-run of the effect (here: a pin) rebuilds the joins while still at overview scale.
      rerender(<GraphCanvas {...props} positions={[{ entryId: 'A', x: 10, y: 20 }]} />);
      for (const label of Array.from(container.querySelectorAll('text.node-label'))) {
        expect(label.getAttribute('opacity')).toBe('0');
      }
    });

    it('scales the node radius with degree — a hub is drawn bigger than a leaf', () => {
      const { container } = renderGraph();
      const r = (id: string) =>
        Number(container.querySelector(`g[data-node-id="${id}"] circle.medallion-disc`)!.getAttribute('r'));
      expect(r('A')).toBe(16); // degree 1 → clamp(14, 14 + 2*1, 26)
      expect(r('B')).toBe(18); // degree 2 → clamp(14, 14 + 2*2, 26)
      expect(r('B')).toBeGreaterThan(r('A'));
    });

    it('keeps the node clickable — the medallion art must not swallow the click', () => {
      // The disc/art sit on top of the group. If the art intercepted pointer events, nodes
      // would become click-dead-zones and NO existing test would catch it.
      const onNodeClick = vi.fn();
      const { container } = renderGraph({ onNodeClick });
      const group = container.querySelector('g[data-node-id="A"]') as SVGGElement;
      group.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      expect(onNodeClick).toHaveBeenCalledTimes(1);

      // And a click that lands on the medallion art itself must still reach the node.
      const disc = container.querySelector('g[data-node-id="B"] circle.medallion-disc') as SVGCircleElement;
      disc.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      expect(onNodeClick).toHaveBeenCalledTimes(2);
    });

    it('marks the cover, the glyph and the label pointer-events:none so the disc stays the hit target', () => {
      const medallions = new Map([
        ['A', { title: 'Aldric', entryType: 'entity', icon: '', coverThumbUrl: '/thumb-a.png' }],
      ]);
      const { container } = renderGraph({ medallions });
      const cover = container.querySelector('g[data-node-id="A"] image')!;
      const glyph = container.querySelector('g[data-node-id="B"] text.medallion-glyph')!;
      const label = container.querySelector('g[data-node-id="A"] text.node-label')!;
      expect(cover.getAttribute('pointer-events')).toBe('none');
      expect(glyph.getAttribute('pointer-events')).toBe('none');
      expect(label.getAttribute('pointer-events')).toBe('none');
    });
  });
});
