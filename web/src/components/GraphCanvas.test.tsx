import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
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
      />,
    );
    expect(container.querySelectorAll('circle')).toHaveLength(3);
    expect(container.querySelectorAll('line')).toHaveLength(2);
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
      />,
    );
    const circles = Array.from(container.querySelectorAll('circle'));
    const fills = circles.map((c) => c.getAttribute('fill'));
    // concept = #3b82f6, location = #f59e0b, faction = #a855f7 (from entryTypeColor.ts)
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
      />,
    );
    const labels = Array.from(container.querySelectorAll('text.edge-label'));
    // e1 has label 'lives-in'; e2 has empty label → filtered out
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
      />,
    );
    const circle = container.querySelectorAll('circle')[0] as SVGCircleElement;
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
      />,
    );
    const circle = container.querySelectorAll('circle')[1] as SVGCircleElement;
    circle.dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true }));
    expect(onPinNode).toHaveBeenCalledTimes(1);
    expect(onNodeClick).not.toHaveBeenCalled();
    expect(onPinNode.mock.calls[0][0]).toMatchObject({ id: 'B' });
  });

  it('respects the positions array by pinning fx/fy so those nodes stay put', () => {
    const nodes: GraphNode[] = [
      makeNode({ id: 'A' }),
      makeNode({ id: 'B' }),
    ];
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
      />,
    );
    // After simulation ticks, the pinned node should be at (150, 250) because fx/fy force it.
    const circles = Array.from(container.querySelectorAll('circle')) as SVGCircleElement[];
    const a = circles.find((c) => c.getAttribute('data-node-id') === 'A');
    expect(a).toBeTruthy();
    expect(Number(a!.getAttribute('cx'))).toBeCloseTo(150, 0);
    expect(Number(a!.getAttribute('cy'))).toBeCloseTo(250, 0);
  });
});
