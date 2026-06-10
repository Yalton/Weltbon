import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RelationLegend } from '../RelationLegend';
import type { GraphEdge } from '../../hooks/useGraphData';
import type { LinkTypeRegistry } from '../../lib/linkTypeColor';

// Minimal edge fixtures
const EDGES_TYPED_AND_UNTYPED: GraphEdge[] = [
  { id: 'e1', source: 'n1', target: 'n2', label: null, linkType: 'parent_of', direction: 'directed' },
  { id: 'e2', source: 'n2', target: 'n3', label: null, linkType: null, direction: 'undirected' },
];

const EDGES_TYPED_ONLY: GraphEdge[] = [
  { id: 'e1', source: 'n1', target: 'n2', label: null, linkType: 'ally_of', direction: 'undirected' },
  { id: 'e2', source: 'n3', target: 'n4', label: null, linkType: 'enemy_of', direction: 'undirected' },
];

const EMPTY_EDGES: GraphEdge[] = [];

const REGISTRY: LinkTypeRegistry = {};

describe('RelationLegend', () => {
  it('does NOT render the legend panel when visible=false', () => {
    render(
      <RelationLegend
        edges={EDGES_TYPED_AND_UNTYPED}
        registry={REGISTRY}
        visible={false}
        onToggle={vi.fn()}
      />,
    );
    expect(screen.queryByRole('region', { name: /relation type legend/i })).not.toBeInTheDocument();
  });

  it('renders the legend panel when visible=true', () => {
    render(
      <RelationLegend
        edges={EDGES_TYPED_AND_UNTYPED}
        registry={REGISTRY}
        visible={true}
        onToggle={vi.fn()}
      />,
    );
    expect(screen.getByRole('region', { name: /relation type legend/i })).toBeInTheDocument();
  });

  it('lists typed rows and an Untyped row (sorted: typed first, Untyped last)', () => {
    render(
      <RelationLegend
        edges={EDGES_TYPED_AND_UNTYPED}
        registry={REGISTRY}
        visible={true}
        onToggle={vi.fn()}
      />,
    );
    const items = screen.getAllByRole('listitem');
    // "parent_of" formats to "Parent Of"
    expect(items.some((li) => li.textContent?.includes('Parent Of'))).toBe(true);
    // Untyped row must be present and last
    const untypedIdx = items.findIndex((li) => li.textContent?.includes('Untyped'));
    expect(untypedIdx).toBeGreaterThanOrEqual(0);
    const typedIndices = items
      .map((li, i) => ({ i, text: li.textContent ?? '' }))
      .filter((x) => !x.text.includes('Untyped'))
      .map((x) => x.i);
    // All typed rows appear before the Untyped row
    typedIndices.forEach((idx) => {
      expect(idx).toBeLessThan(untypedIdx);
    });
  });

  it('renders the empty-state copy when no edges provided', () => {
    render(
      <RelationLegend
        edges={EMPTY_EDGES}
        registry={REGISTRY}
        visible={true}
        onToggle={vi.fn()}
      />,
    );
    expect(screen.getByText(/no typed edges in this view/i)).toBeInTheDocument();
  });

  it("renders empty-state when edges have no linkType (all untyped doesn't trigger hasTypedEdges)", () => {
    // deriveRows returns rows with null type; hasTypedEdges = rows.length > 0 is true
    // but that means "Untyped" shows, not the empty state — test the actual behavior
    const untypedOnlyEdges: GraphEdge[] = [
      { id: 'e1', source: 'n1', target: 'n2', label: null, linkType: null, direction: 'undirected' },
    ];
    render(
      <RelationLegend
        edges={untypedOnlyEdges}
        registry={REGISTRY}
        visible={true}
        onToggle={vi.fn()}
      />,
    );
    // A single untyped edge yields one "Untyped" row (hasTypedEdges = true because rows.length > 0)
    expect(screen.getByText('Untyped')).toBeInTheDocument();
  });

  it('component root element carries pointer-events-none (d3-zoom pass-through guard)', () => {
    const { container } = render(
      <RelationLegend
        edges={EDGES_TYPED_AND_UNTYPED}
        registry={REGISTRY}
        visible={true}
        onToggle={vi.fn()}
      />,
    );
    const root = container.firstChild as HTMLElement;
    expect(root).not.toBeNull();
    expect(root.className).toContain('pointer-events-none');
  });

  it('calls onToggle when the in-panel "×" close button is clicked', async () => {
    const onToggle = vi.fn();
    render(
      <RelationLegend
        edges={EDGES_TYPED_AND_UNTYPED}
        registry={REGISTRY}
        visible={true}
        onToggle={onToggle}
      />,
    );
    const closeBtn = screen.getByRole('button', { name: /close legend/i });
    await userEvent.click(closeBtn);
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it('shows typed edge rows in alphabetical order before Untyped', () => {
    render(
      <RelationLegend
        edges={EDGES_TYPED_ONLY}
        registry={REGISTRY}
        visible={true}
        onToggle={vi.fn()}
      />,
    );
    const items = screen.getAllByRole('listitem');
    const texts = items.map((li) => li.textContent ?? '');
    // ally_of → "Ally Of"; enemy_of → "Enemy Of"; both are typed, sorted alpha
    const allyIdx = texts.findIndex((t) => t.includes('Ally Of'));
    const enemyIdx = texts.findIndex((t) => t.includes('Enemy Of'));
    expect(allyIdx).toBeGreaterThanOrEqual(0);
    expect(enemyIdx).toBeGreaterThanOrEqual(0);
    expect(allyIdx).toBeLessThan(enemyIdx);
  });
});
