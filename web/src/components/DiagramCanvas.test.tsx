/**
 * DiagramCanvas render/SVG regression tests (DIAGRAM-08).
 *
 * Tests:
 *  1. Given N nodes the SVG contains N <circle> elements with r=14 (DIAGRAM-01)
 *  2. A 'dashed' edge renders a line with a non-empty stroke-dasharray; a
 *     'solid' edge has none (DIAGRAM-02)
 *  3. Reduced-motion safe: node positions update synchronously — no JS
 *     animation applied to node positions (DIAGRAM-05 Animation Contract)
 *  4. The SVG exposes role="application" and aria-label="Diagram canvas"
 *     (DIAGRAM-05/a11y)
 */
import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import { DiagramCanvas } from './DiagramCanvas';
import type { CanvasNode } from './DiagramCanvas';
import type { DiagramEdge } from '../hooks/useDiagram';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeNode(
  id: string,
  entryId: string,
  overrides: Partial<CanvasNode> = {},
): CanvasNode {
  return {
    id,
    diagramId: 'diagram-1',
    entryId,
    x: overrides.x ?? 100,
    y: overrides.y ?? 100,
    title: overrides.title ?? `Entry ${entryId}`,
    entryType: overrides.entryType ?? 'concept',
  };
}

function makeEdge(
  id: string,
  sourceEntryId: string,
  targetEntryId: string,
  lineStyle: DiagramEdge['lineStyle'] = 'solid',
  label: string | null = null,
): DiagramEdge {
  return {
    id,
    universeId: 'u1',
    sourceEntryId,
    targetEntryId,
    label,
    direction: 'directed',
    linkType: null,
    diagramId: 'diagram-1',
    lineStyle,
    color: '#6b7280',
    createdAt: '2026-01-01T00:00:00Z',
  };
}

function emptyHandlers() {
  return {
    onDrawEdge: vi.fn(),
    onSelfDrop: vi.fn(),
    onMoveNode: vi.fn(),
    onSelectNode: vi.fn(),
    onSelectEdge: vi.fn(),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('DiagramCanvas', () => {
  it('renders one circle per node with r=14 (DIAGRAM-01)', () => {
    const nodes: CanvasNode[] = [
      makeNode('n1', 'e1', { x: 50, y: 50, entryType: 'concept' }),
      makeNode('n2', 'e2', { x: 150, y: 50, entryType: 'location' }),
      makeNode('n3', 'e3', { x: 250, y: 150, entryType: 'faction' }),
    ];

    const { container } = render(
      <DiagramCanvas
        nodes={nodes}
        edges={[]}
        selection={new Set()}
        selectedEdgeId={null}
        editMode={false}
        {...emptyHandlers()}
      />,
    );

    const circles = container.querySelectorAll('g.nodes circle');
    expect(circles).toHaveLength(3);
    // All node circles must have r=14
    circles.forEach((c) => {
      expect(c.getAttribute('r')).toBe('14');
    });
  });

  it('colors each circle by entryType using entryTypeHexColor (DIAGRAM-01)', () => {
    const nodes: CanvasNode[] = [
      makeNode('n1', 'e1', { entryType: 'concept' }),
      makeNode('n2', 'e2', { entryType: 'location' }),
    ];

    const { container } = render(
      <DiagramCanvas
        nodes={nodes}
        edges={[]}
        selection={new Set()}
        selectedEdgeId={null}
        editMode={false}
        {...emptyHandlers()}
      />,
    );

    const circles = Array.from(container.querySelectorAll('g.nodes circle'));
    const fills = circles.map((c) => c.getAttribute('fill'));
    // concept = #3b82f6, location = #f59e0b (from entryTypeColor.ts)
    expect(fills).toContain('#3b82f6');
    expect(fills).toContain('#f59e0b');
  });

  it('dashed edge renders a line with a non-empty stroke-dasharray (DIAGRAM-02)', () => {
    const nodes: CanvasNode[] = [
      makeNode('n1', 'e1', { x: 50, y: 50 }),
      makeNode('n2', 'e2', { x: 150, y: 50 }),
    ];
    const edges: DiagramEdge[] = [makeEdge('edge-1', 'e1', 'e2', 'dashed')];

    const { container } = render(
      <DiagramCanvas
        nodes={nodes}
        edges={edges}
        selection={new Set()}
        selectedEdgeId={null}
        editMode={false}
        {...emptyHandlers()}
      />,
    );

    const lines = container.querySelectorAll('g.edges line');
    expect(lines).toHaveLength(1);
    const dashArray = lines[0].getAttribute('stroke-dasharray');
    expect(dashArray).not.toBeNull();
    expect(dashArray!.length).toBeGreaterThan(0);
  });

  it('solid edge renders a line with an empty stroke-dasharray (DIAGRAM-02)', () => {
    const nodes: CanvasNode[] = [
      makeNode('n1', 'e1', { x: 50, y: 50 }),
      makeNode('n2', 'e2', { x: 150, y: 50 }),
    ];
    const edges: DiagramEdge[] = [makeEdge('edge-1', 'e1', 'e2', 'solid')];

    const { container } = render(
      <DiagramCanvas
        nodes={nodes}
        edges={edges}
        selection={new Set()}
        selectedEdgeId={null}
        editMode={false}
        {...emptyHandlers()}
      />,
    );

    const lines = container.querySelectorAll('g.edges line');
    expect(lines).toHaveLength(1);
    // solid -> dashArrayFor returns '' (empty string attribute)
    const dashArray = lines[0].getAttribute('stroke-dasharray') ?? '';
    expect(dashArray).toBe('');
  });

  it('dotted edge renders a line with a non-empty stroke-dasharray (DIAGRAM-02)', () => {
    const nodes: CanvasNode[] = [
      makeNode('n1', 'e1', { x: 50, y: 50 }),
      makeNode('n2', 'e2', { x: 150, y: 50 }),
    ];
    const edges: DiagramEdge[] = [makeEdge('edge-1', 'e1', 'e2', 'dotted')];

    const { container } = render(
      <DiagramCanvas
        nodes={nodes}
        edges={edges}
        selection={new Set()}
        selectedEdgeId={null}
        editMode={false}
        {...emptyHandlers()}
      />,
    );

    const lines = container.querySelectorAll('g.edges line');
    expect(lines).toHaveLength(1);
    const dashArray = lines[0].getAttribute('stroke-dasharray');
    expect(dashArray).not.toBeNull();
    expect(dashArray!.length).toBeGreaterThan(0);
  });

  it(
    'reduced-motion safe: node positions are written synchronously — no JS animation (DIAGRAM-05)',
    () => {
      // Positions are set directly from node.x/node.y without any async
      // animation or transition. After render the node group transform
      // must reflect the exact prop coordinates (Animation Contract).
      const nodes: CanvasNode[] = [
        makeNode('n1', 'e1', { x: 75, y: 125 }),
        makeNode('n2', 'e2', { x: 200, y: 300 }),
      ];

      const { container } = render(
        <DiagramCanvas
          nodes={nodes}
          edges={[]}
          selection={new Set()}
          selectedEdgeId={null}
          editMode={false}
          {...emptyHandlers()}
        />,
      );

      const groups = container.querySelectorAll<SVGGElement>('g.nodes g.node-group');
      expect(groups).toHaveLength(2);

      // The translate should reflect the provided x/y coordinates.
      const transforms = Array.from(groups).map((g) => g.getAttribute('transform'));
      expect(transforms).toContain('translate(75,125)');
      expect(transforms).toContain('translate(200,300)');
    },
  );

  it('SVG exposes role="application" and aria-label="Diagram canvas" (DIAGRAM-05/a11y)', () => {
    const { container } = render(
      <DiagramCanvas
        nodes={[]}
        edges={[]}
        selection={new Set()}
        selectedEdgeId={null}
        editMode={false}
        {...emptyHandlers()}
      />,
    );

    const svg = container.querySelector('svg');
    expect(svg).not.toBeNull();
    expect(svg!.getAttribute('role')).toBe('application');
    expect(svg!.getAttribute('aria-label')).toBe('Diagram canvas');
  });

  it('applies cursor-crosshair class to SVG when editMode=true', () => {
    const { container } = render(
      <DiagramCanvas
        nodes={[]}
        edges={[]}
        selection={new Set()}
        selectedEdgeId={null}
        editMode={true}
        {...emptyHandlers()}
      />,
    );

    const svg = container.querySelector('svg');
    expect(svg?.getAttribute('class')).toMatch(/cursor-crosshair/);
  });
});
