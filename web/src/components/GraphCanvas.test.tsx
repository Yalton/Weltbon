import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import { act } from 'react';
import { GraphCanvas } from './GraphCanvas';
import type { GraphNode, GraphEdge, GraphPosition } from '../hooks/useGraphData';

function makeNode(overrides: Partial<GraphNode> & { id: string }): GraphNode {
  return {
    id: overrides.id,
    title: overrides.title ?? `Node ${overrides.id}`,
    entryType: overrides.entryType ?? 'concept',
    summary: overrides.summary ?? '',
    icon: overrides.icon ?? '',
  };
}

function makeEdge(id: string, source: string, target: string, label = ''): GraphEdge {
  return { id, source, target, label, bidirectional: false };
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

function dispatchPointerDown(circle: Element, clientX: number, clientY: number) {
  act(() => {
    circle.dispatchEvent(
      new PointerEvent('pointerdown', {
        bubbles: true,
        clientX,
        clientY,
        pointerType: 'mouse',
        button: 0,
      }),
    );
  });
}

function dispatchPointerMove(clientX: number, clientY: number) {
  act(() => {
    window.dispatchEvent(
      new PointerEvent('pointermove', {
        bubbles: true,
        clientX,
        clientY,
        pointerType: 'mouse',
      }),
    );
  });
}

function dispatchPointerUp(clientX: number, clientY: number) {
  act(() => {
    window.dispatchEvent(
      new PointerEvent('pointerup', {
        bubbles: true,
        clientX,
        clientY,
        pointerType: 'mouse',
      }),
    );
  });
}

function dispatchEscape() {
  act(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  });
}

describe('GraphCanvas', () => {
  it('renders one circle per node and one line per edge', () => {
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
    expect(container.querySelectorAll('g.nodes circle')).toHaveLength(3);
    expect(container.querySelectorAll('g.links line')).toHaveLength(2);
  });

  it('colors each circle by entryType using entryTypeHexColor', () => {
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
    const circles = Array.from(container.querySelectorAll('g.nodes circle'));
    const fills = circles.map((c) => c.getAttribute('fill'));
    expect(fills).toContain('#3b82f6');
    expect(fills).toContain('#f59e0b');
    expect(fills).toContain('#a855f7');
  });

  it('renders edge labels for edges that have a label', () => {
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
    const circle = container.querySelectorAll('g.nodes circle')[0] as SVGCircleElement;
    circle.dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: false }));
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
    const circle = container.querySelectorAll('g.nodes circle')[1] as SVGCircleElement;
    circle.dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true }));
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
    const circles = Array.from(container.querySelectorAll('g.nodes circle')) as SVGCircleElement[];
    const a = circles.find((c) => c.getAttribute('data-node-id') === 'A');
    expect(a).toBeTruthy();
    expect(Number(a!.getAttribute('cx'))).toBeCloseTo(150, 0);
    expect(Number(a!.getAttribute('cy'))).toBeCloseTo(250, 0);
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

      const circleA = container.querySelector(
        'g.nodes circle[data-node-id="A"]',
      ) as SVGCircleElement;
      const rect = circleA.getBoundingClientRect();
      dispatchPointerDown(circleA, rect.left + rect.width / 2, rect.top + rect.height / 2);

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
      const circleA = container.querySelector(
        'g.nodes circle[data-node-id="A"]',
      ) as SVGCircleElement;
      const aRect = circleA.getBoundingClientRect();
      dispatchPointerDown(circleA, aRect.left + aRect.width / 2, aRect.top + aRect.height / 2);
      dispatchPointerMove(aRect.left + 100, aRect.top + 50);

      const preview = container.querySelector('[data-testid="graph-preview-edge"]') as SVGLineElement;
      expect(preview).toBeTruthy();
      // d3-drag's evt.x/y are simulation-space; after a move event x2/y2 should
      // have changed from the initial drag-start pointer position. We assert
      // x2 and y2 are non-null (the preview-edge is rendered with both coords
      // sourced from React state).
      expect(preview.getAttribute('x2')).not.toBeNull();
      expect(preview.getAttribute('y2')).not.toBeNull();
      // x2 should differ from the starting simulation-space coordinate of circleA.
      const ax = Number(circleA.getAttribute('cx'));
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
      const circleA = container.querySelector(
        'g.nodes circle[data-node-id="A"]',
      ) as SVGCircleElement;
      const circleB = container.querySelector(
        'g.nodes circle[data-node-id="B"]',
      ) as SVGCircleElement;
      const aRect = circleA.getBoundingClientRect();
      const bRect = circleB.getBoundingClientRect();

      vi.spyOn(document, 'elementFromPoint').mockReturnValue(circleB as Element);

      dispatchPointerDown(circleA, aRect.left + aRect.width / 2, aRect.top + aRect.height / 2);
      dispatchPointerMove(bRect.left + bRect.width / 2, bRect.top + bRect.height / 2);
      dispatchPointerUp(bRect.left + bRect.width / 2, bRect.top + bRect.height / 2);

      expect(onLinkDragEnd).toHaveBeenCalledTimes(1);
      expect(onLinkDragEnd.mock.calls[0][0]).toMatchObject({ id: 'A' });
      expect(onLinkDragEnd.mock.calls[0][1]).toMatchObject({ id: 'B' });
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
      const circleA = container.querySelector(
        'g.nodes circle[data-node-id="A"]',
      ) as SVGCircleElement;
      const aRect = circleA.getBoundingClientRect();

      vi.spyOn(document, 'elementFromPoint').mockReturnValue(circleA as Element);

      dispatchPointerDown(circleA, aRect.left + aRect.width / 2, aRect.top + aRect.height / 2);
      // No move beyond 5px so it counts as click-ish but pointerup still triggers end
      dispatchPointerMove(aRect.left + aRect.width / 2 + 6, aRect.top + aRect.height / 2 + 6);
      dispatchPointerUp(aRect.left + aRect.width / 2 + 6, aRect.top + aRect.height / 2 + 6);

      expect(onLinkDragEnd).toHaveBeenCalledTimes(1);
      expect(onLinkDragEnd.mock.calls[0][0]).toMatchObject({ id: 'A' });
      expect(onLinkDragEnd.mock.calls[0][1]).toBe('self');
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
      const circleA = container.querySelector(
        'g.nodes circle[data-node-id="A"]',
      ) as SVGCircleElement;
      const aRect = circleA.getBoundingClientRect();

      vi.spyOn(document, 'elementFromPoint').mockReturnValue(null);

      dispatchPointerDown(circleA, aRect.left + aRect.width / 2, aRect.top + aRect.height / 2);
      dispatchPointerMove(aRect.left + 200, aRect.top + 200);
      dispatchPointerUp(aRect.left + 200, aRect.top + 200);

      expect(onLinkDragEnd).toHaveBeenCalledTimes(1);
      expect(onLinkDragEnd.mock.calls[0][0]).toMatchObject({ id: 'A' });
      expect(onLinkDragEnd.mock.calls[0][1]).toBeNull();
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
      const circleA = container.querySelector(
        'g.nodes circle[data-node-id="A"]',
      ) as SVGCircleElement;
      const circleB = container.querySelector(
        'g.nodes circle[data-node-id="B"]',
      ) as SVGCircleElement;
      const aRect = circleA.getBoundingClientRect();
      const bRect = circleB.getBoundingClientRect();
      vi.spyOn(document, 'elementFromPoint').mockReturnValue(circleB as Element);

      dispatchPointerDown(circleA, aRect.left + aRect.width / 2, aRect.top + aRect.height / 2);
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
      const circleA = container.querySelector(
        'g.nodes circle[data-node-id="A"]',
      ) as SVGCircleElement;
      const cxBefore = circleA.getAttribute('cx');
      const cyBefore = circleA.getAttribute('cy');

      const aRect = circleA.getBoundingClientRect();
      vi.spyOn(document, 'elementFromPoint').mockReturnValue(null);
      dispatchPointerDown(circleA, aRect.left, aRect.top);
      dispatchPointerMove(aRect.left + 100, aRect.top + 100);
      dispatchEscape();

      // Pin state preserved structurally — edit-mode drag never mutated fx/fy.
      // Assert via cx/cy still matching the pinned coordinates.
      expect(circleA.getAttribute('cx')).toBe(cxBefore);
      expect(circleA.getAttribute('cy')).toBe(cyBefore);
      expect(Number(circleA.getAttribute('cx'))).toBeCloseTo(150, 0);
      expect(Number(circleA.getAttribute('cy'))).toBeCloseTo(250, 0);
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
      const circle = container.querySelector(
        'g.nodes circle[data-node-id="B"]',
      ) as SVGCircleElement;
      circle.dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true }));
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
      const circleA = container.querySelector(
        'g.nodes circle[data-node-id="A"]',
      ) as SVGCircleElement;
      const circleB = container.querySelector(
        'g.nodes circle[data-node-id="B"]',
      ) as SVGCircleElement;
      const aRect = circleA.getBoundingClientRect();
      const bRect = circleB.getBoundingClientRect();
      vi.spyOn(document, 'elementFromPoint').mockReturnValue(circleB as Element);

      dispatchPointerDown(circleA, aRect.left + aRect.width / 2, aRect.top + aRect.height / 2);
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
      const circleA = container.querySelector(
        'g.nodes circle[data-node-id="A"]',
      ) as SVGCircleElement;
      const aRect = circleA.getBoundingClientRect();

      dispatchPointerDown(circleA, aRect.left + aRect.width / 2, aRect.top + aRect.height / 2);
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
      const circleA = container.querySelector(
        'g.nodes circle[data-node-id="A"]',
      ) as SVGCircleElement;
      const aRect = circleA.getBoundingClientRect();
      dispatchPointerDown(circleA, aRect.left, aRect.top);
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
      const circleA = container.querySelector(
        'g.nodes circle[data-node-id="A"]',
      ) as SVGCircleElement;
      const aRect = circleA.getBoundingClientRect();
      vi.spyOn(document, 'elementFromPoint').mockReturnValue(null);
      expect(() => {
        dispatchPointerDown(circleA, aRect.left, aRect.top);
        dispatchPointerMove(aRect.left + 30, aRect.top + 30);
        dispatchEscape();
        dispatchPointerUp(aRect.left + 30, aRect.top + 30);
      }).not.toThrow();
    });
  });
});
