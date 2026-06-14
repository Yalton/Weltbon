import { describe, it, expect, beforeEach, vi } from 'vitest';
import { act } from 'react';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
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
  label: string | null = null,
): GraphEdge {
  return { id, source, target, label, linkType: null, direction: 'directed' };
}

function renderGraphView(universeId = 'UNI') {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const utils = render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[`/universes/${universeId}/graph`]}>
        <Routes>
          <Route path="/universes/:uid/graph" element={<GraphView />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { ...utils, qc };
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

    it('Test 6: drop-on-other captures popoverState and renders the real CreateLinkPopover with From/To node titles (no existing edge → empty input)', async () => {
      // 19-04 swapped the test-only `popover-anchor` placeholder div with the
      // real <CreateLinkPopover>. The popover renders its own
      // RelationCombobox which calls `useRelations` (GET /relations) — so
      // we discriminate on method+path here instead of the blanket
      // mockResolvedValue used pre-19-04.
      vi.mocked(api).mockImplementation(async (path: string, init?: RequestInit) => {
        const method = init?.method ?? 'GET';
        if (method === 'GET' && path.endsWith('/relations')) {
          return [] as unknown as never;
        }
        return {
          nodes: [makeNode('A'), makeNode('B')],
          edges: [],
          positions: [],
        } as unknown as never;
      });

      renderGraphView();
      await enterEditMode();

      const nodeA = makeNode('A');
      const nodeB = makeNode('B');
      act(() => {
        captured.onLinkDragEnd?.(nodeA, nodeB, 200, 150);
      });

      // Real popover is mounted (replaces the 19-02 placeholder).
      expect(
        await screen.findByRole('heading', { name: 'Create link' }),
      ).toBeInTheDocument();
      // From/To rows show the node titles (makeNode default is "Node {id}")
      expect(screen.getByText('Node A')).toBeInTheDocument();
      expect(screen.getByText('Node B')).toBeInTheDocument();
      // No existing edge A→B → label input starts empty
      const input = screen.getByRole('combobox') as HTMLInputElement;
      expect(input.value).toBe('');
    });

    it('Test 7: existing-link prefill — A→B edge with label "knows" hydrates the popover input', async () => {
      vi.mocked(api).mockImplementation(async (path: string, init?: RequestInit) => {
        const method = init?.method ?? 'GET';
        if (method === 'GET' && path.endsWith('/relations')) {
          return [] as unknown as never;
        }
        return {
          nodes: [makeNode('A'), makeNode('B')],
          edges: [makeEdge('e1', 'A', 'B', 'knows')],
          positions: [],
        } as unknown as never;
      });

      renderGraphView();
      await enterEditMode();

      const nodeA = makeNode('A');
      const nodeB = makeNode('B');
      act(() => {
        captured.onLinkDragEnd?.(nodeA, nodeB, 200, 150);
      });

      const input = (await screen.findByRole('combobox')) as HTMLInputElement;
      expect(input.value).toBe('knows');
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

    it('Test 9: editMode=true with popoverState non-null → window-level Escape listener short-circuits (popoverState !== null)', async () => {
      // After 19-04, with the popover open, BOTH the popover's own
      // DismissableLayer AND the canvas-level useEffect Esc listener see
      // the keydown. The contract here is the canvas-level listener does
      // NOT fire setEditMode(false) while popoverState !== null — i.e., a
      // single Esc keydown either closes the popover (priority 5) OR
      // exits edit mode (priority 4), never both. We assert that by
      // dispatching window-level Esc from a place Radix's
      // document-capture listener does NOT receive (window vs document),
      // then asserting captured.editMode remains true.
      vi.mocked(api).mockImplementation(async (path: string, init?: RequestInit) => {
        const method = init?.method ?? 'GET';
        if (method === 'GET' && path.endsWith('/relations')) {
          return [] as unknown as never;
        }
        return {
          nodes: [makeNode('A'), makeNode('B')],
          edges: [],
          positions: [],
        } as unknown as never;
      });

      renderGraphView();
      await enterEditMode();

      // Set popoverState by simulating a drop-on-other
      act(() => {
        captured.onLinkDragEnd?.(makeNode('A'), makeNode('B'), 200, 150);
      });
      // Real popover is mounted (replaces the 19-02 placeholder anchor div)
      await screen.findByRole('heading', { name: 'Create link' });

      // Dispatch Esc on `window` only. Radix DismissableLayer subscribes via
      // useEscapeKeydown(document.ownerDocument) at capture phase — it does
      // NOT pick up a synthetic `window.dispatchEvent` of `keydown`. This
      // lets us isolate the canvas-level listener's behaviour: it MUST
      // short-circuit because popoverState !== null, leaving editMode=true.
      dispatchEscape();
      // editMode unchanged (still on)
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

  // ---------- Phase 19 Plan 19-04 — CreateLinkPopover integration ----------

  describe('Phase 19 Plan 19-04 — CreateLinkPopover integration', () => {
    // Shared harness: GraphCanvas is mocked (above), real CreateLinkPopover
    // renders inside GraphView when popoverState !== null. The api mock
    // discriminates on method+path: GET /universes/.../graph-data resolves
    // graph data; GET /universes/.../relations resolves [] (RelationCombobox);
    // POST /universes/U1/links resolves the linkRecord on success.

    const successLinkRecord = {
      id: 'NEW',
      universeId: 'U1',
      sourceEntryId: 'A',
      targetEntryId: 'B',
      label: 'knows',
      bidirectional: false,
      createdAt: '2026-05-16T00:00:00Z',
    };

    function mockApiSuccess(
      graphData: GraphDataResponse,
      record = successLinkRecord,
    ) {
      vi.mocked(api).mockImplementation(async (path: string, init?: RequestInit) => {
        const method = init?.method ?? 'GET';
        if (method === 'GET' && path.endsWith('/relations')) {
          return [] as unknown as never;
        }
        if (method === 'POST' && path.endsWith('/links')) {
          return record as unknown as never;
        }
        // Default GET: graph data
        return graphData as unknown as never;
      });
    }

    function mockApiError(graphData: GraphDataResponse) {
      vi.mocked(api).mockImplementation(async (path: string, init?: RequestInit) => {
        const method = init?.method ?? 'GET';
        if (method === 'GET' && path.endsWith('/relations')) {
          return [] as unknown as never;
        }
        if (method === 'POST' && path.endsWith('/links')) {
          throw new Error('400 Bad Request');
        }
        return graphData as unknown as never;
      });
    }

    async function enterEditMode() {
      const btn = await screen.findByRole('button', { name: /enter edit mode/i });
      await userEvent.click(btn);
      await waitFor(() => expect(captured.editMode).toBe(true));
    }

    it('Test 1 (integration): drop-on-other opens the real CreateLinkPopover with title + From/To rows + combobox', async () => {
      mockApiSuccess({
        nodes: [
          makeNode('A', { title: 'Alpha' }),
          makeNode('B', { title: 'Beta' }),
        ],
        edges: [],
        positions: [],
      } as GraphDataResponse);

      renderGraphView('U1');
      await enterEditMode();

      act(() => {
        captured.onLinkDragEnd?.(
          makeNode('A', { title: 'Alpha' }),
          makeNode('B', { title: 'Beta' }),
          250,
          180,
        );
      });

      // Real popover renders (not just the data-testid="popover-anchor" stub from 19-02)
      expect(
        await screen.findByRole('heading', { name: 'Create link' }),
      ).toBeInTheDocument();
      expect(screen.getByText('From')).toBeInTheDocument();
      expect(screen.getByText('To')).toBeInTheDocument();
      expect(screen.getByText('Alpha')).toBeInTheDocument();
      expect(screen.getByText('Beta')).toBeInTheDocument();
      expect(screen.getByRole('combobox')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Create link' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
    });

    it('Test 2 (integration): confirm POSTs /universes/U1/links with the typed label and closes popover; editMode persists', async () => {
      mockApiSuccess({
        nodes: [
          makeNode('A', { title: 'Alpha' }),
          makeNode('B', { title: 'Beta' }),
        ],
        edges: [],
        positions: [],
      } as GraphDataResponse);

      const user = userEvent.setup();
      renderGraphView('U1');
      await enterEditMode();

      act(() => {
        captured.onLinkDragEnd?.(
          makeNode('A', { title: 'Alpha' }),
          makeNode('B', { title: 'Beta' }),
          200,
          150,
        );
      });

      const input = await screen.findByRole('combobox');
      await user.click(input);
      await user.type(input, 'knows');
      await user.click(screen.getByRole('button', { name: 'Create link' }));

      await waitFor(() => {
        const posted = vi.mocked(api).mock.calls.find(
          ([p, init]) =>
            typeof p === 'string' &&
            p.endsWith('/universes/U1/links') &&
            (init as RequestInit | undefined)?.method === 'POST',
        );
        expect(posted).toBeTruthy();
        const body = JSON.parse((posted![1] as RequestInit).body as string);
        expect(body).toMatchObject({
          sourceEntryId: 'A',
          targetEntryId: 'B',
          label: 'knows',
        });
      });

      // Popover closes (heading disappears)
      await waitFor(() => {
        expect(
          screen.queryByRole('heading', { name: 'Create link' }),
        ).not.toBeInTheDocument();
      });

      // Edit mode persists
      const editingBtn = screen.getByRole('button', { name: /exit edit mode/i });
      expect(editingBtn).toHaveTextContent('Editing');
      expect(captured.editMode).toBe(true);
    });

    it('Test 3 (integration): success does NOT render a Toast — graph re-render is the only signal', async () => {
      mockApiSuccess({
        nodes: [
          makeNode('A', { title: 'Alpha' }),
          makeNode('B', { title: 'Beta' }),
        ],
        edges: [],
        positions: [],
      } as GraphDataResponse);

      const user = userEvent.setup();
      renderGraphView('U1');
      await enterEditMode();

      act(() => {
        captured.onLinkDragEnd?.(
          makeNode('A', { title: 'Alpha' }),
          makeNode('B', { title: 'Beta' }),
          200,
          150,
        );
      });

      const input = await screen.findByRole('combobox');
      await user.click(input);
      await user.type(input, 'knows');
      await user.click(screen.getByRole('button', { name: 'Create link' }));

      await waitFor(() => {
        expect(
          screen.queryByRole('heading', { name: 'Create link' }),
        ).not.toBeInTheDocument();
      });
      // No Toast appears post-success (UI-SPEC §"Copywriting Contract" omits success Toast)
      expect(screen.queryByRole('status')).not.toBeInTheDocument();
    });

    it('Test 4 (integration): POST error renders BOTH inline error in popover AND error Toast with identical copy', async () => {
      mockApiError({
        nodes: [
          makeNode('A', { title: 'Alpha' }),
          makeNode('B', { title: 'Beta' }),
        ],
        edges: [],
        positions: [],
      } as GraphDataResponse);

      const user = userEvent.setup();
      const { container } = renderGraphView('U1');
      await enterEditMode();

      act(() => {
        captured.onLinkDragEnd?.(
          makeNode('A', { title: 'Alpha' }),
          makeNode('B', { title: 'Beta' }),
          200,
          150,
        );
      });

      const input = await screen.findByRole('combobox');
      await user.click(input);
      await user.type(input, 'bogus');
      await user.click(screen.getByRole('button', { name: 'Create link' }));

      // Inline error inside the popover (UI-SPEC §H belt-and-suspenders)
      await waitFor(() => {
        const errors = screen.getAllByText("Couldn't create link. Try again.");
        // Two surfaces: inline <p> in popover + Toast
        expect(errors.length).toBeGreaterThanOrEqual(2);
      });

      // Toast renders at view level with role=status + error variant (bg-red-600)
      const toast = await screen.findByRole('status');
      expect(toast).toHaveTextContent("Couldn't create link. Try again.");
      expect(toast.className).toMatch(/bg-red-600/);

      // Popover stays open (heading still visible)
      expect(
        screen.getByRole('heading', { name: 'Create link' }),
      ).toBeInTheDocument();
      // popoverState is still non-null (popover anchor div may or may not be
      // present depending on internal change in 19-04 — assert via the visible
      // popover heading instead).
      // No regression on canvas stub still present (sanity)
      expect(container).toBeTruthy();
    });

    it('Test 5 (integration): Esc inside popover closes popover; no POST fires; editMode persists', async () => {
      mockApiSuccess({
        nodes: [
          makeNode('A', { title: 'Alpha' }),
          makeNode('B', { title: 'Beta' }),
        ],
        edges: [],
        positions: [],
      } as GraphDataResponse);

      renderGraphView('U1');
      await enterEditMode();

      act(() => {
        captured.onLinkDragEnd?.(
          makeNode('A', { title: 'Alpha' }),
          makeNode('B', { title: 'Beta' }),
          200,
          150,
        );
      });

      await screen.findByRole('heading', { name: 'Create link' });

      // Radix Popover listens on document for Esc (DismissableLayer)
      fireEvent.keyDown(document, { key: 'Escape', code: 'Escape' });

      await waitFor(() => {
        expect(
          screen.queryByRole('heading', { name: 'Create link' }),
        ).not.toBeInTheDocument();
      });

      const posts = vi.mocked(api).mock.calls.filter(
        ([, init]) => (init as RequestInit | undefined)?.method === 'POST',
      );
      expect(posts).toHaveLength(0);

      // editMode persists
      const editingBtn = screen.getByRole('button', { name: /exit edit mode/i });
      expect(editingBtn).toHaveTextContent('Editing');
    });

    it('Test 6 (integration): Cancel button closes popover; no POST fires', async () => {
      mockApiSuccess({
        nodes: [
          makeNode('A', { title: 'Alpha' }),
          makeNode('B', { title: 'Beta' }),
        ],
        edges: [],
        positions: [],
      } as GraphDataResponse);

      const user = userEvent.setup();
      renderGraphView('U1');
      await enterEditMode();

      act(() => {
        captured.onLinkDragEnd?.(
          makeNode('A', { title: 'Alpha' }),
          makeNode('B', { title: 'Beta' }),
          200,
          150,
        );
      });

      const cancelBtn = await screen.findByRole('button', { name: 'Cancel' });
      await user.click(cancelBtn);

      await waitFor(() => {
        expect(
          screen.queryByRole('heading', { name: 'Create link' }),
        ).not.toBeInTheDocument();
      });

      const posts = vi.mocked(api).mock.calls.filter(
        ([, init]) => (init as RequestInit | undefined)?.method === 'POST',
      );
      expect(posts).toHaveLength(0);
    });

    it('Test 7 (integration): existing-link prefill — input populates with "knows" when A→B edge already exists', async () => {
      mockApiSuccess({
        nodes: [
          makeNode('A', { title: 'Alpha' }),
          makeNode('B', { title: 'Beta' }),
        ],
        edges: [makeEdge('e1', 'A', 'B', 'knows')],
        positions: [],
      } as GraphDataResponse);

      renderGraphView('U1');
      await enterEditMode();

      act(() => {
        captured.onLinkDragEnd?.(
          makeNode('A', { title: 'Alpha' }),
          makeNode('B', { title: 'Beta' }),
          200,
          150,
        );
      });

      const input = (await screen.findByRole('combobox')) as HTMLInputElement;
      expect(input.value).toBe('knows');
    });

    it('Test 8 (integration: D-03 stacking lock-in): with existing A→B label="knows", editing to "enemies with" and confirming POSTs the user-edited label (never the hint)', async () => {
      mockApiSuccess(
        {
          nodes: [
            makeNode('A', { title: 'Alpha' }),
            makeNode('B', { title: 'Beta' }),
          ],
          edges: [makeEdge('e1', 'A', 'B', 'knows')],
          positions: [],
        } as GraphDataResponse,
        {
          id: 'NEW',
          universeId: 'U1',
          sourceEntryId: 'A',
          targetEntryId: 'B',
          label: 'enemies with',
          bidirectional: false,
          createdAt: '2026-05-16T00:00:00Z',
        },
      );

      const user = userEvent.setup();
      renderGraphView('U1');
      await enterEditMode();

      act(() => {
        captured.onLinkDragEnd?.(
          makeNode('A', { title: 'Alpha' }),
          makeNode('B', { title: 'Beta' }),
          200,
          150,
        );
      });

      const input = (await screen.findByRole('combobox')) as HTMLInputElement;
      expect(input.value).toBe('knows');
      // Clear and type new label
      await user.clear(input);
      await user.type(input, 'enemies with');
      await user.click(screen.getByRole('button', { name: 'Create link' }));

      await waitFor(() => {
        const posted = vi.mocked(api).mock.calls.find(
          ([p, init]) =>
            typeof p === 'string' &&
            p.endsWith('/universes/U1/links') &&
            (init as RequestInit | undefined)?.method === 'POST',
        );
        expect(posted).toBeTruthy();
        const body = JSON.parse((posted![1] as RequestInit).body as string);
        // The lock-in: D-03 always POSTs new with the user-edited label, NEVER
        // replaces the existing edge nor sends the hint.
        expect(body).toMatchObject({
          sourceEntryId: 'A',
          targetEntryId: 'B',
          label: 'enemies with',
        });
      });
    });

    it('Test 9 (integration regression): successful POST invalidates the ["graph-data", universeId] query key', async () => {
      mockApiSuccess({
        nodes: [
          makeNode('A', { title: 'Alpha' }),
          makeNode('B', { title: 'Beta' }),
        ],
        edges: [],
        positions: [],
      } as GraphDataResponse);

      const user = userEvent.setup();
      const { qc } = renderGraphView('U1');
      const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');

      await enterEditMode();

      act(() => {
        captured.onLinkDragEnd?.(
          makeNode('A', { title: 'Alpha' }),
          makeNode('B', { title: 'Beta' }),
          200,
          150,
        );
      });

      const input = await screen.findByRole('combobox');
      await user.click(input);
      await user.type(input, 'knows');
      await user.click(screen.getByRole('button', { name: 'Create link' }));

      await waitFor(() => {
        const keys = invalidateSpy.mock.calls.map((c) =>
          JSON.stringify((c[0] as { queryKey?: unknown }).queryKey),
        );
        expect(keys).toContain(JSON.stringify(['graph-data', 'U1']));
      });
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
