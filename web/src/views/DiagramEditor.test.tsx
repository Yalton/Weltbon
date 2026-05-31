/**
 * DiagramEditor orchestration tests (DIAGRAM-03/04).
 *
 * Tests:
 *  1. Editor renders toolbar stat reflecting mocked node/edge counts
 *  2. Toggling Edit sets aria-pressed=true on the Edit toggle button
 *  3. Export JSON calls URL.createObjectURL (DIAGRAM-03 export)
 *  4. With Family tree mode on, clicking Auto-layout invokes the move-node mutation (DIAGRAM-04)
 *  5. Undo after a tracked op restores prior state (undo handler re-applies a position)
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { act } from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

// Per-file api/client mock (mirrors GraphView.test.tsx convention).
vi.mock('../api/client', () => ({ api: vi.fn() }));

// Mock DiagramCanvas so we can control callbacks without needing d3/jsdom SVG.
// Exposes test buttons to fire canvas events synthetically.
type MockCanvasCallbacks = {
  onMoveNode?: (entryId: string, x: number, y: number) => void;
  onSelfDrop?: () => void;
  onDrawEdge?: (srcId: string, tgtId: string, coords: { x: number; y: number }) => void;
  editMode?: boolean;
};
const capturedCanvas: MockCanvasCallbacks = {};

vi.mock('../components/DiagramCanvas', () => ({
  DiagramCanvas: (props: MockCanvasCallbacks) => {
    capturedCanvas.onMoveNode = props.onMoveNode;
    capturedCanvas.onSelfDrop = props.onSelfDrop;
    capturedCanvas.onDrawEdge = props.onDrawEdge;
    capturedCanvas.editMode = props.editMode;
    return (
      <div
        data-testid="diagram-canvas-stub"
        data-edit-mode={String(props.editMode)}
      >
        <button
          type="button"
          data-testid="stub-move-node"
          onClick={() => props.onMoveNode?.('entry-A', 250, 300)}
        >
          [stub] move node
        </button>
      </div>
    );
  },
}));

// Mock DrawEdgePopover (we don't need full popover in editor tests)
vi.mock('../components/DrawEdgePopover', () => ({
  DrawEdgePopover: () => <div data-testid="draw-edge-popover-stub" />,
  EDGE_PALETTE: ['#6b7280', '#3b82f6'],
}));

// Mock AddEntriesPicker (out of scope for editor orchestration tests)
vi.mock('../components/AddEntriesPicker', () => ({
  AddEntriesPicker: () => <div data-testid="add-entries-picker-stub" />,
}));

import { api } from '../api/client';
import { DiagramEditor } from './DiagramEditor';
import type { DiagramDetail } from '../hooks/useDiagram';
import type { Entry } from '../hooks/useEntries';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeDiagramDetail(
  nodeCount: number,
  edgeCount: number,
): DiagramDetail {
  const nodes = Array.from({ length: nodeCount }, (_, i) => ({
    id: `node-${i}`,
    diagramId: 'diag-1',
    entryId: `entry-${String.fromCharCode(65 + i)}`,
    x: i * 100,
    y: 100,
  }));
  const edges = Array.from({ length: edgeCount }, (_, i) => ({
    id: `edge-${i}`,
    universeId: 'uni-1',
    sourceEntryId: nodes[0]?.entryId ?? 'entry-A',
    targetEntryId: nodes[1]?.entryId ?? 'entry-B',
    label: i === 0 ? 'parent' : null,
    bidirectional: false,
    diagramId: 'diag-1',
    lineStyle: 'solid' as const,
    color: '#6b7280',
    createdAt: '2026-01-01T00:00:00Z',
  }));
  return {
    id: 'diag-1',
    universeId: 'uni-1',
    name: 'Test Diagram',
    description: null,
    createdAt: '2026-01-01T00:00:00Z',
    nodes,
    edges,
  };
}

function makeEntries(count: number): Entry[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `entry-${String.fromCharCode(65 + i)}`,
    universeId: 'uni-1',
    title: `Entry ${String.fromCharCode(65 + i)}`,
    entryType: 'concept',
    summary: '',
    tags: [],
    meta: {},
    icon: '',
    categoryId: null,
    isPublic: false,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  }));
}

function renderEditor(uid = 'uni-1', did = 'diag-1') {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[`/universes/${uid}/diagrams/${did}`]}>
        <Routes>
          <Route path="/universes/:uid/diagrams/:did" element={<DiagramEditor />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('DiagramEditor', () => {
  beforeEach(() => {
    vi.mocked(api).mockReset();
    capturedCanvas.editMode = undefined;
    capturedCanvas.onMoveNode = undefined;
    capturedCanvas.onSelfDrop = undefined;
    capturedCanvas.onDrawEdge = undefined;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('Test 1: toolbar stat reflects mocked node/edge counts', async () => {
    vi.mocked(api).mockImplementation(async (path: string) => {
      if (path.includes('/entries')) return makeEntries(3) as never;
      return makeDiagramDetail(3, 2) as never;
    });

    renderEditor();

    // The toolbar stat should show "3 nodes · 2 edges"
    expect(await screen.findByText('3 nodes · 2 edges')).toBeInTheDocument();
  });

  it('Test 2: clicking Edit sets aria-pressed=true on the Edit toggle', async () => {
    vi.mocked(api).mockImplementation(async (path: string) => {
      if (path.includes('/entries')) return makeEntries(2) as never;
      return makeDiagramDetail(2, 0) as never;
    });

    const user = userEvent.setup();
    renderEditor();

    const editBtn = await screen.findByRole('button', { name: /enter edit mode/i });
    expect(editBtn.getAttribute('aria-pressed')).toBe('false');

    await user.click(editBtn);

    const editBtnOn = await screen.findByRole('button', { name: /exit edit mode/i });
    expect(editBtnOn.getAttribute('aria-pressed')).toBe('true');
    expect(editBtnOn).toHaveTextContent('Editing');
  });

  it('Test 3: Export JSON calls URL.createObjectURL (DIAGRAM-03)', async () => {
    vi.mocked(api).mockImplementation(async (path: string) => {
      if (path.includes('/entries') && !path.includes('/diagrams')) return makeEntries(2) as never;
      return makeDiagramDetail(2, 1) as never;
    });

    const user = userEvent.setup();
    renderEditor();

    // Wait for the toolbar to appear (diagram loaded).
    const exportBtn = await screen.findByRole('button', { name: /export json/i });

    // jsdom does not implement URL.createObjectURL — assign stubs after render
    // to avoid interfering with fetch internals during component mount.
    const createObjectURLStub = vi.fn().mockReturnValue('blob:test');
    const revokeObjectURLStub = vi.fn();
    URL.createObjectURL = createObjectURLStub;
    URL.revokeObjectURL = revokeObjectURLStub;

    // Stub document.body.appendChild/removeChild to prevent jsdom navigation error.
    const appendSpy = vi.spyOn(document.body, 'appendChild').mockImplementation((el) => el);
    const removeSpy = vi.spyOn(document.body, 'removeChild').mockImplementation((el) => el);

    await user.click(exportBtn);

    expect(createObjectURLStub).toHaveBeenCalledOnce();
    // Cleanup
    appendSpy.mockRestore();
    removeSpy.mockRestore();
  });

  it('Test 4: Family tree mode on + Auto-layout invokes the move-node mutation (DIAGRAM-04)', async () => {
    vi.mocked(api).mockImplementation(async (path: string, init?: RequestInit) => {
      if (path.includes('/entries')) return makeEntries(3) as never;
      if ((init?.method ?? 'GET') === 'PATCH' && path.includes('/nodes')) {
        return { id: 'node-0', diagramId: 'diag-1', entryId: 'entry-A', x: 0, y: 0 } as never;
      }
      return makeDiagramDetail(3, 1) as never;
    });

    const user = userEvent.setup();
    renderEditor();

    await screen.findByText(/nodes/);

    // Enable family tree mode
    const checkbox = screen.getByRole('checkbox', { name: /family tree mode/i });
    await user.click(checkbox);

    // Auto-layout button should now be visible
    const autoLayoutBtn = await screen.findByRole('button', { name: /auto-layout/i });
    await user.click(autoLayoutBtn);

    // Wait for PATCH mutations to be called
    await waitFor(() => {
      const patches = vi.mocked(api).mock.calls.filter(
        ([p, init]) =>
          typeof p === 'string' &&
          p.includes('/nodes') &&
          (init as RequestInit | undefined)?.method === 'PATCH',
      );
      expect(patches.length).toBeGreaterThanOrEqual(1);
    });
  });

  it('Test 5: Undo after a tracked node move reverts the position (DIAGRAM-03)', async () => {
    vi.mocked(api).mockImplementation(async (path: string, init?: RequestInit) => {
      if (path.includes('/entries')) return makeEntries(2) as never;
      if ((init?.method ?? 'GET') === 'PATCH' && path.includes('/nodes')) {
        return { id: 'node-0', diagramId: 'diag-1', entryId: 'entry-A', x: 0, y: 0 } as never;
      }
      return makeDiagramDetail(2, 0) as never;
    });

    const user = userEvent.setup();
    renderEditor();

    await screen.findByText(/nodes/);

    // Simulate a node move via the canvas stub button
    const moveBtn = screen.getByTestId('stub-move-node');
    await user.click(moveBtn);

    // Wait for the PATCH to fire (the move was tracked)
    await waitFor(() => {
      const patches = vi.mocked(api).mock.calls.filter(
        ([p, init]) =>
          typeof p === 'string' &&
          p.includes('/nodes') &&
          (init as RequestInit | undefined)?.method === 'PATCH',
      );
      expect(patches.length).toBeGreaterThanOrEqual(1);
    });

    // Now click Undo — should fire another PATCH to restore prev position
    const patchCountBefore = vi.mocked(api).mock.calls.filter(
      ([p, init]) =>
        typeof p === 'string' &&
        p.includes('/nodes') &&
        (init as RequestInit | undefined)?.method === 'PATCH',
    ).length;

    // Undo button should be enabled now
    const undoBtn = screen.getByRole('button', { name: 'Undo' });
    expect(undoBtn.getAttribute('aria-disabled')).toBe('false');
    await user.click(undoBtn);

    // Another PATCH should have fired for the undo (restoring previous position)
    await waitFor(() => {
      const patches = vi.mocked(api).mock.calls.filter(
        ([p, init]) =>
          typeof p === 'string' &&
          p.includes('/nodes') &&
          (init as RequestInit | undefined)?.method === 'PATCH',
      );
      expect(patches.length).toBeGreaterThan(patchCountBefore);
    });
  });
});
