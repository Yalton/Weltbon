/**
 * DiagramEditor orchestration tests (DIAGRAM-03/04).
 *
 * Tests:
 *  1. Editor renders toolbar stat reflecting mocked node/edge counts
 *  2. Toggling Edit sets aria-pressed=true on the Edit toggle button
 *  3. Export JSON calls URL.createObjectURL (DIAGRAM-03 export)
 *  4. With layout-mode set to Family tree via selector, clicking Auto-layout invokes the move-node mutation (DIAGRAM-04)
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
  onEditEdge?: (edgeId: string, coords: { x: number; y: number }) => void;
  onEditNode?: (entryId: string) => void;
  onSelectNode?: (id: string | null, addToSelection?: boolean) => void;
  editMode?: boolean;
};
const capturedCanvas: MockCanvasCallbacks = {};

vi.mock('../components/DiagramCanvas', () => ({
  DiagramCanvas: (props: MockCanvasCallbacks) => {
    capturedCanvas.onMoveNode = props.onMoveNode;
    capturedCanvas.onSelfDrop = props.onSelfDrop;
    capturedCanvas.onDrawEdge = props.onDrawEdge;
    capturedCanvas.onEditEdge = props.onEditEdge;
    capturedCanvas.onEditNode = props.onEditNode;
    capturedCanvas.onSelectNode = props.onSelectNode;
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
        <button
          type="button"
          data-testid="stub-edit-edge"
          onClick={() => props.onEditEdge?.('edge-0', { x: 100, y: 100 })}
        >
          [stub] edit edge
        </button>
        <button
          type="button"
          data-testid="stub-edit-node"
          onClick={() => props.onEditNode?.('entry-A')}
        >
          [stub] edit node
        </button>
        {/* Select two nodes to set up multi-selection for align tests */}
        <button
          type="button"
          data-testid="stub-select-node-a"
          onClick={() => props.onSelectNode?.('entry-A', false)}
        >
          [stub] select A
        </button>
        <button
          type="button"
          data-testid="stub-select-node-b"
          onClick={() => props.onSelectNode?.('entry-B', true)}
        >
          [stub] select B (add)
        </button>
      </div>
    );
  },
}));

// Mock DrawEdgePopover — capture mode + onSubmit for edit-edge assertions.
type MockPopoverProps = {
  open?: boolean;
  mode?: string;
  initialEdge?: { label: string; lineStyle: string; color: string };
  onSubmit?: (opts: { label: string; lineStyle: string; color: string }) => Promise<void>;
};
const capturedPopover: MockPopoverProps = {};
vi.mock('../components/DrawEdgePopover', () => ({
  DrawEdgePopover: (props: MockPopoverProps) => {
    capturedPopover.open = props.open;
    capturedPopover.mode = props.mode;
    capturedPopover.initialEdge = props.initialEdge;
    capturedPopover.onSubmit = props.onSubmit;
    return (
      <div data-testid="draw-edge-popover-stub" data-mode={props.mode ?? 'create'}>
        {props.mode === 'edit' && props.initialEdge && (
          <span data-testid="popover-initial-label">{props.initialEdge.label}</span>
        )}
        <button
          type="button"
          data-testid="stub-popover-save"
          onClick={() =>
            props.onSubmit?.({
              label: props.initialEdge?.label ?? 'updated',
              lineStyle: props.initialEdge?.lineStyle ?? 'dotted',
              color: props.initialEdge?.color ?? '#f43f5e',
            })
          }
        >
          [stub] save
        </button>
      </div>
    );
  },
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
    capturedCanvas.onEditEdge = undefined;
    capturedCanvas.onEditNode = undefined;
    capturedCanvas.onSelectNode = undefined;
    capturedPopover.open = undefined;
    capturedPopover.mode = undefined;
    capturedPopover.initialEdge = undefined;
    capturedPopover.onSubmit = undefined;
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

  it('Test 4: Layout mode selector + Auto-layout invokes the move-node mutation (DIAGRAM-04)', async () => {
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

    // Open the layout-mode Radix Select and choose "Family tree mode"
    const layoutTrigger = screen.getByRole('combobox', { name: /layout mode/i });
    await user.click(layoutTrigger);
    const familyTreeOption = await screen.findByRole('option', { name: /family tree mode/i });
    await user.click(familyTreeOption);

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

  it('Test 6: triggering edit-edge opens DrawEdgePopover in edit mode pre-filled with edge values', async () => {
    vi.mocked(api).mockImplementation(async (path: string) => {
      if (path.includes('/entries')) return makeEntries(2) as never;
      return makeDiagramDetail(2, 1) as never;
    });

    const user = userEvent.setup();
    renderEditor();

    await screen.findByText(/nodes/);

    // Trigger onEditEdge via stub button
    const editEdgeBtn = screen.getByTestId('stub-edit-edge');
    await user.click(editEdgeBtn);

    // Popover should appear in edit mode
    await waitFor(() => {
      const popover = screen.getByTestId('draw-edge-popover-stub');
      expect(popover.getAttribute('data-mode')).toBe('edit');
    });

    // Initial edge label should be pre-filled (edge-0 has label='parent' from makeDiagramDetail)
    const labelEl = screen.getByTestId('popover-initial-label');
    expect(labelEl.textContent).toBe('parent');
  });

  it('Test 7: saving edge edit calls the PATCH update-edge mutation', async () => {
    vi.mocked(api).mockImplementation(async (path: string, init?: RequestInit) => {
      if (path.includes('/entries')) return makeEntries(2) as never;
      if ((init?.method ?? 'GET') === 'PATCH' && path.includes('/edges')) {
        return {
          id: 'edge-0', universeId: 'uni-1', sourceEntryId: 'entry-A',
          targetEntryId: 'entry-B', label: 'updated', bidirectional: false,
          diagramId: 'diag-1', lineStyle: 'dotted', color: '#f43f5e',
          createdAt: '2026-01-01T00:00:00Z',
        } as never;
      }
      return makeDiagramDetail(2, 1) as never;
    });

    const user = userEvent.setup();
    renderEditor();

    await screen.findByText(/nodes/);

    // Open edit-edge popover
    const editEdgeBtn = screen.getByTestId('stub-edit-edge');
    await user.click(editEdgeBtn);

    // Wait for popover to appear in edit mode
    await waitFor(() => {
      expect(screen.getByTestId('draw-edge-popover-stub').getAttribute('data-mode')).toBe('edit');
    });

    // Click save in the popover stub
    const saveBtn = screen.getByTestId('stub-popover-save');
    await user.click(saveBtn);

    // A PATCH to /edges should have fired
    await waitFor(() => {
      const patches = vi.mocked(api).mock.calls.filter(
        ([p, init]) =>
          typeof p === 'string' &&
          p.includes('/edges') &&
          (init as RequestInit | undefined)?.method === 'PATCH',
      );
      expect(patches.length).toBeGreaterThanOrEqual(1);
    });
  });

  it('Test 8: triggering edit-node opens the rename panel', async () => {
    vi.mocked(api).mockImplementation(async (path: string) => {
      if (path.includes('/entries')) return makeEntries(2) as never;
      return makeDiagramDetail(2, 0) as never;
    });

    const user = userEvent.setup();
    renderEditor();

    await screen.findByText(/nodes/);

    // Trigger onEditNode via stub button
    const editNodeBtn = screen.getByTestId('stub-edit-node');
    await user.click(editNodeBtn);

    // Rename panel should appear with current title pre-filled
    await waitFor(() => {
      expect(screen.getByTestId('rename-node-panel')).toBeInTheDocument();
    });
    const input = screen.getByTestId('rename-node-input') as HTMLInputElement;
    // Entry A's title is 'Entry A' from makeEntries
    expect(input.value).toBe('Entry A');
  });

  it('Test 9: align action on multi-selection invokes the move-node mutation (DIAGRAM-01/03)', async () => {
    vi.mocked(api).mockImplementation(async (path: string, init?: RequestInit) => {
      if (path.includes('/entries')) return makeEntries(3) as never;
      if ((init?.method ?? 'GET') === 'PATCH' && path.includes('/nodes')) {
        return { id: 'node-0', diagramId: 'diag-1', entryId: 'entry-A', x: 0, y: 0 } as never;
      }
      return makeDiagramDetail(3, 0) as never;
    });

    const user = userEvent.setup();
    renderEditor();

    await screen.findByText(/nodes/);

    // Select node A (single select)
    const selectA = screen.getByTestId('stub-select-node-a');
    await user.click(selectA);

    // Add node B to selection (shift-select via addToSelection=true)
    const selectB = screen.getByTestId('stub-select-node-b');
    await user.click(selectB);

    // The "Align left" button should now be visible (selectionCount >= 2)
    const alignLeftBtn = await screen.findByRole('button', { name: /align left/i });
    await user.click(alignLeftBtn);

    // Move-node mutation (PATCH /nodes) should fire for the aligned nodes
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
