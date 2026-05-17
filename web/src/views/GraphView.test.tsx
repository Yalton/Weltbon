import { describe, it, expect, beforeEach, vi } from 'vitest';
import { act } from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

// Mock useNavigate BEFORE importing GraphView.
const navigateMock = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return { ...actual, useNavigate: () => navigateMock };
});

// Mock api client — GraphView uses useGraphData (GET) and two mutations.
vi.mock('../api/client', () => ({ api: vi.fn() }));

// Mock GraphCanvas for the orchestration-state tests (Tests 4-11). The
// mock exposes the props as data attributes so behaviour assertions can
// read them, AND surfaces test-only buttons that drive the
// onLinkDragEnd / onDragSourceChange callbacks synthetically. This keeps
// these tests focused on GraphView state machine; the canvas-side drag
// pipeline is covered by GraphCanvas.test.tsx.
//
// The captured props are stashed on a module-level ref so individual
// tests can read the latest invocation. Test bodies set sentinel values
// (e.g., `lastCanvasProps.from = nodeA;`) via the harness helpers below.
type CapturedProps = {
  editMode: boolean | null;
  onLinkDragEnd:
    | ((from: unknown, to: unknown, x: number, y: number) => void)
    | null;
  onDragSourceChange: ((id: string | null) => void) | null;
  nodes: Array<{ id: string }>;
};
const captured: CapturedProps = {
  editMode: null,
  onLinkDragEnd: null,
  onDragSourceChange: null,
  nodes: [],
};

vi.mock('../components/GraphCanvas', () => ({
  GraphCanvas: (props: {
    editMode: boolean;
    onLinkDragEnd: (
      from: { id: string },
      to: { id: string } | 'self' | null,
      x: number,
      y: number,
    ) => void;
    onDragSourceChange?: (sourceId: string | null) => void;
    nodes: Array<{ id: string }>;
  }) => {
    captured.editMode = props.editMode;
    captured.onLinkDragEnd =
      props.onLinkDragEnd as CapturedProps['onLinkDragEnd'];
    captured.onDragSourceChange =
      props.onDragSourceChange ?? null;
    captured.nodes = props.nodes;
    return (
      <div
        data-testid="graph-canvas-stub"
        data-edit-mode={String(props.editMode)}
        data-node-count={String(props.nodes.length)}
      />
    );
  },
}));

import { api } from '../api/client';
import { GraphView } from './GraphView';
import type { GraphDataResponse, GraphNode, GraphEdge } from '../hooks/useGraphData';

function makeNode(id: string, overrides: Partial<GraphNode> = {}): GraphNode {
  return {
    id,
    title: `Node ${id}`,
    entryType: 'concept',
    summary: '',
    icon: '',
    ...overrides,
  };
}

function makeEdge(
  id: string,
  source: string,
  target: string,
  label = '',
): GraphEdge {
  return { id, source, target, label, bidirectional: false };
}

function renderGraphView(universeId = 'UNI') {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[`/universes/${universeId}/graph`]}>
        <Routes>
          <Route path="/universes/:uid/graph" element={<GraphView />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function resetCaptured() {
  captured.editMode = null;
  captured.onLinkDragEnd = null;
  captured.onDragSourceChange = null;
  captured.nodes = [];
}

describe('GraphView', () => {
  beforeEach(() => {
    vi.mocked(api).mockReset();
    navigateMock.mockReset();
    resetCaptured();
  });

  it('renders EmptyState when the universe has zero nodes', async () => {
    const response: GraphDataResponse = { nodes: [], edges: [], positions: [] };
    vi.mocked(api).mockResolvedValue(response);

    renderGraphView();

    expect(
      await screen.findByText(/the graph draws itself once entries exist/i),
    ).toBeInTheDocument();
  });

  it('renders the GraphCanvas with every node when the universe is small', async () => {
    const response: GraphDataResponse = {
      nodes: [makeNode('A'), makeNode('B'), makeNode('C')],
      edges: [makeEdge('e1', 'A', 'B'), makeEdge('e2', 'B', 'C')],
      positions: [],
    };
    vi.mocked(api).mockResolvedValue(response);

    renderGraphView();

    await screen.findByTestId('graph-canvas-stub');
    expect(captured.nodes).toHaveLength(3);
  });

  it('renders the subgraph filter banner when the universe has more than 300 nodes', async () => {
    const nodes = Array.from({ length: 301 }, (_, i) => makeNode(`n${i}`));
    const response: GraphDataResponse = { nodes, edges: [], positions: [] };
    vi.mocked(api).mockResolvedValue(response);

    renderGraphView();

    expect(
      await screen.findByText(/too many to render at once/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/this universe has 301 entries/i),
    ).toBeInTheDocument();
  });

  it('renders a reduced node set after the user picks a focus entry in the subgraph filter', async () => {
    const nodes = Array.from({ length: 301 }, (_, i) => makeNode(`n${i}`));
    const edges = [makeEdge('e1', 'n0', 'n1'), makeEdge('e2', 'n0', 'n2')];
    vi.mocked(api).mockResolvedValue({ nodes, edges, positions: [] });

    renderGraphView();

    const focusSelect = await screen.findByRole('combobox', {
      name: /focus entry/i,
    });
    await userEvent.selectOptions(focusSelect, 'n0');

    await waitFor(() => {
      expect(captured.nodes).toHaveLength(3);
    });
  });

  it('fires the reset-layout DELETE when the Reset layout button is clicked', async () => {
    vi.mocked(api).mockImplementation(async (path: string, init?: RequestInit) => {
      if (!init || init.method === undefined || init.method === 'GET') {
        return {
          nodes: [makeNode('A'), makeNode('B')],
          edges: [],
          positions: [],
        } as GraphDataResponse;
      }
      if (init.method === 'DELETE') return undefined;
      return undefined;
    });

    renderGraphView();

    const resetButton = await screen.findByRole('button', {
      name: /reset layout/i,
    });
    await userEvent.click(resetButton);

    await waitFor(() => {
      const calls = vi.mocked(api).mock.calls;
      const deleted = calls.some(
        ([p, init]) => p.endsWith('/graph-positions') && init?.method === 'DELETE',
      );
      expect(deleted).toBe(true);
    });
  });

  // ---------- Phase 19 Plan 19-02 ----------

  describe('Phase 19 — edit-mode toggle (GRAPH-01)', () => {
    it('Test 1: toggle button initial render carries off-state copy + aria + title', async () => {
      vi.mocked(api).mockResolvedValue({
        nodes: [makeNode('A'), makeNode('B')],
        edges: [],
        positions: [],
      } as GraphDataResponse);

      renderGraphView();

      const btn = await screen.findByRole('button', { name: /enter edit mode/i });
      expect(btn).toHaveTextContent('Edit');
      expect(btn.getAttribute('aria-pressed')).toBe('false');
      expect(btn.getAttribute('aria-label')).toBe('Enter edit mode');
      expect(btn.getAttribute('title')).toBe(
        'Drag between entries to create a link',
      );
    });

    it('Test 2: clicking the toggle flips text/aria/title and propagates editMode to GraphCanvas', async () => {
      vi.mocked(api).mockResolvedValue({
        nodes: [makeNode('A'), makeNode('B')],
        edges: [],
        positions: [],
      } as GraphDataResponse);

      renderGraphView();

      const btn = await screen.findByRole('button', { name: /enter edit mode/i });
      // Canvas stub mounted with editMode=false
      await waitFor(() => {
        expect(screen.getByTestId('graph-canvas-stub').getAttribute('data-edit-mode')).toBe('false');
      });

      await userEvent.click(btn);

      const btnOn = await screen.findByRole('button', { name: /exit edit mode/i });
      expect(btnOn).toHaveTextContent('Editing');
      expect(btnOn.getAttribute('aria-pressed')).toBe('true');
      expect(btnOn.getAttribute('aria-label')).toBe('Exit edit mode');
      expect(btnOn.getAttribute('title')).toBe('Press Esc to exit edit mode');
      expect(captured.editMode).toBe(true);
      expect(screen.getByTestId('graph-canvas-stub').getAttribute('data-edit-mode')).toBe('true');
    });

    it('Test 3: toggle button and Reset layout share a flex items-center gap-2 parent (toggle precedes Reset in DOM order)', async () => {
      vi.mocked(api).mockResolvedValue({
        nodes: [makeNode('A'), makeNode('B')],
        edges: [],
        positions: [],
      } as GraphDataResponse);

      renderGraphView();

      const toggle = await screen.findByRole('button', { name: /enter edit mode/i });
      const reset = await screen.findByRole('button', { name: /reset layout/i });
      expect(toggle.parentElement).toBe(reset.parentElement);
      const cluster = toggle.parentElement;
      expect(cluster?.className).toMatch(/flex/);
      expect(cluster?.className).toMatch(/items-center/);
      expect(cluster?.className).toMatch(/gap-2/);
      // DOM order: toggle precedes Reset
      const children = Array.from(cluster?.children ?? []);
      expect(children.indexOf(toggle)).toBeLessThan(children.indexOf(reset));
    });
  });

  describe('Phase 19 — handleLinkDragEnd routing (GRAPH-05)', () => {
    async function enterEditMode() {
      const btn = await screen.findByRole('button', { name: /enter edit mode/i });
      await userEvent.click(btn);
      await waitFor(() => expect(captured.editMode).toBe(true));
    }

    it('Test 4: self-drop renders a Toast with the locked copy + error variant + 3s duration', async () => {
      vi.mocked(api).mockResolvedValue({
        nodes: [makeNode('A'), makeNode('B')],
        edges: [],
        positions: [],
      } as GraphDataResponse);

      renderGraphView();
      await enterEditMode();

      const nodeA: GraphNode = makeNode('A');
      act(() => {
        captured.onLinkDragEnd?.(nodeA, 'self', 100, 100);
      });

      const toast = await screen.findByRole('status');
      expect(toast).toHaveTextContent("Can't link an entry to itself.");
      // Error variant uses bg-red-600 (Toast.tsx); success uses bg-emerald-600
      expect(toast.className).toMatch(/bg-red-600/);
    });

    it('Test 5: empty-canvas drop is silent — no toast, no popoverState side effect', async () => {
      vi.mocked(api).mockResolvedValue({
        nodes: [makeNode('A'), makeNode('B')],
        edges: [],
        positions: [],
      } as GraphDataResponse);

      const { container } = renderGraphView();
      await enterEditMode();

      const nodeA: GraphNode = makeNode('A');
      act(() => {
        captured.onLinkDragEnd?.(nodeA, null, 50, 60);
      });

      // No toast renders
      expect(screen.queryByRole('status')).toBeNull();
      // No popover-anchor data attribute appears either
      expect(container.querySelector('[data-testid="popover-anchor"]')).toBeNull();
    });

    it('Test 6: drop-on-other captures popoverState with container-relative coords (no existing edge → no hint)', async () => {
      vi.mocked(api).mockResolvedValue({
        nodes: [makeNode('A'), makeNode('B')],
        edges: [],
        positions: [],
      } as GraphDataResponse);

      const { container } = renderGraphView();
      await enterEditMode();

      const nodeA = makeNode('A');
      const nodeB = makeNode('B');
      act(() => {
        captured.onLinkDragEnd?.(nodeA, nodeB, 200, 150);
      });

      // The plan exposes popoverState via a test-only data attribute on the
      // GraphView root container (rendered when popoverState !== null) so
      // 19-04 can swap it for the real CreateLinkPopover render.
      const anchor = await waitFor(() =>
        container.querySelector('[data-testid="popover-anchor"]') as HTMLElement | null,
      );
      expect(anchor).toBeTruthy();
      expect(anchor?.getAttribute('data-from-id')).toBe('A');
      expect(anchor?.getAttribute('data-to-id')).toBe('B');
      // jsdom's getBoundingClientRect returns 0,0 by default, so dropX === dropClientX,
      // dropY === dropClientY here.
      expect(Number(anchor?.getAttribute('data-drop-x'))).toBeCloseTo(200);
      expect(Number(anchor?.getAttribute('data-drop-y'))).toBeCloseTo(150);
      // No existing edge A→B → no hint attribute (or empty)
      const hint = anchor?.getAttribute('data-existing-label-hint');
      expect(hint === null || hint === '').toBe(true);
    });

    it('Test 7: existing-link prefill — A→B edge with label "knows" populates existingLabelHint', async () => {
      vi.mocked(api).mockResolvedValue({
        nodes: [makeNode('A'), makeNode('B')],
        edges: [makeEdge('e1', 'A', 'B', 'knows')],
        positions: [],
      } as GraphDataResponse);

      const { container } = renderGraphView();
      await enterEditMode();

      const nodeA = makeNode('A');
      const nodeB = makeNode('B');
      act(() => {
        captured.onLinkDragEnd?.(nodeA, nodeB, 200, 150);
      });

      const anchor = await waitFor(() =>
        container.querySelector('[data-testid="popover-anchor"]') as HTMLElement | null,
      );
      expect(anchor).toBeTruthy();
      expect(anchor?.getAttribute('data-existing-label-hint')).toBe('knows');
    });
  });

  describe('Phase 19 — canvas-level Esc (UI-SPEC §G)', () => {
    async function enterEditMode() {
      const btn = await screen.findByRole('button', { name: /enter edit mode/i });
      await userEvent.click(btn);
      await waitFor(() => expect(captured.editMode).toBe(true));
    }

    function dispatchEscape() {
      act(() => {
        window.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
        );
      });
    }

    it('Test 8: editMode=true, no popover, no drag → window Escape flips editMode to false', async () => {
      vi.mocked(api).mockResolvedValue({
        nodes: [makeNode('A'), makeNode('B')],
        edges: [],
        positions: [],
      } as GraphDataResponse);

      renderGraphView();
      await enterEditMode();

      dispatchEscape();

      const btnOff = await screen.findByRole('button', { name: /enter edit mode/i });
      expect(btnOff).toHaveTextContent('Edit');
      expect(captured.editMode).toBe(false);
    });

    it('Test 9: editMode=true with popoverState non-null → window Escape does NOT flip editMode', async () => {
      vi.mocked(api).mockResolvedValue({
        nodes: [makeNode('A'), makeNode('B')],
        edges: [],
        positions: [],
      } as GraphDataResponse);

      renderGraphView();
      await enterEditMode();

      // Set popoverState by simulating a drop-on-other
      act(() => {
        captured.onLinkDragEnd?.(makeNode('A'), makeNode('B'), 200, 150);
      });
      // popover anchor present
      await screen.findByTestId('popover-anchor');

      dispatchEscape();
      // editMode unchanged (still on); the popover Esc is handled by 19-04's
      // Radix popover, not the canvas-level listener.
      const btnOn = screen.getByRole('button', { name: /exit edit mode/i });
      expect(btnOn).toHaveTextContent('Editing');
      expect(captured.editMode).toBe(true);
    });

    it('Test 10 (NEW regression): mid-drag Esc does NOT flip editMode; post-cancel Esc does', async () => {
      vi.mocked(api).mockResolvedValue({
        nodes: [makeNode('A'), makeNode('B')],
        edges: [],
        positions: [],
      } as GraphDataResponse);

      renderGraphView();
      await enterEditMode();

      // Simulate drag-start from GraphCanvas — onDragSourceChange('A')
      act(() => {
        captured.onDragSourceChange?.('A');
      });

      // Esc #1 — drag is in flight; canvas-level listener short-circuits
      // because dragSourceId !== null. editMode must remain true.
      dispatchEscape();
      expect(captured.editMode).toBe(true);
      const btnStillOn = screen.getByRole('button', { name: /exit edit mode/i });
      expect(btnStillOn).toHaveTextContent('Editing');

      // Simulate drag-cancel (GraphCanvas fires onDragSourceChange(null))
      act(() => {
        captured.onDragSourceChange?.(null);
      });

      // Esc #2 — no drag in flight, no popover — flips editMode off.
      dispatchEscape();
      const btnOff = await screen.findByRole('button', { name: /enter edit mode/i });
      expect(btnOff).toHaveTextContent('Edit');
      expect(captured.editMode).toBe(false);
    });
  });

  describe('Phase 19 — subgraph-filter coexistence', () => {
    it('Test 11: toggle button renders + is clickable when canvas is hidden by subgraph filter', async () => {
      const nodes = Array.from({ length: 301 }, (_, i) => makeNode(`n${i}`));
      vi.mocked(api).mockResolvedValue({
        nodes,
        edges: [],
        positions: [],
      } as GraphDataResponse);

      renderGraphView();

      // Canvas stub should NOT mount (canvasVisible=false when overThreshold && focus===null)
      await waitFor(() => {
        expect(screen.queryByTestId('graph-canvas-stub')).toBeNull();
      });

      const toggle = await screen.findByRole('button', { name: /enter edit mode/i });
      expect(toggle).toBeInTheDocument();
      await userEvent.click(toggle);
      // After click, aria-pressed flips even though canvas isn't mounted
      const toggleOn = await screen.findByRole('button', { name: /exit edit mode/i });
      expect(toggleOn.getAttribute('aria-pressed')).toBe('true');
    });
  });
});
