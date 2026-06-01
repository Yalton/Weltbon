import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { AddEntriesPicker } from '../components/AddEntriesPicker';
import { DiagramCanvas, type DropCoords } from '../components/DiagramCanvas';
import { DiagramToolbar } from '../components/DiagramToolbar';
import { DrawEdgePopover, type LineStyle, type InitialEdgeValues } from '../components/DrawEdgePopover';
import { Toast } from '../components/Toast';
import {
  useDiagram,
  useAddNode,
  useRemoveNode,
  useMoveNode,
  useCreateEdge,
  useDeleteEdge,
  useUpdateEdge,
  useRenameNode,
} from '../hooks/useDiagram';
import { useEntries } from '../hooks/useEntries';
import { familyTreeLayout } from '../lib/familyTreeLayout';
import { orgChartLayout } from '../lib/orgChartLayout';
import { serializeDiagram } from '../lib/diagramExport';
import type { CanvasNode } from '../components/DiagramCanvas';
import type { DiagramNode, DiagramEdge } from '../hooks/useDiagram';
import type { LayoutMode } from '../components/DiagramToolbar';

// ─── Constants ────────────────────────────────────────────────────────────────

const UNDO_STACK_LIMIT = 50;

// ─── Undo/Redo types ─────────────────────────────────────────────────────────

type NodeMoveOp = {
  type: 'node-move';
  entryId: string;
  prevX: number;
  prevY: number;
  nextX: number;
  nextY: number;
};

type EdgeCreateOp = {
  type: 'edge-create';
  edgeId: string;
};

type EdgeDeleteOp = {
  type: 'edge-delete';
  edge: DiagramEdge;
};

type BatchOp = {
  type: 'batch';
  ops: NodeMoveOp[];
};

type UndoableOp = NodeMoveOp | EdgeCreateOp | EdgeDeleteOp | BatchOp;

// ─── PopoverState ─────────────────────────────────────────────────────────────

type PopoverState = {
  sourceEntryId: string;
  targetEntryId: string;
  dropX: number;
  dropY: number;
} | null;

// ─── EditEdgeState ────────────────────────────────────────────────────────────

type EditEdgeState = {
  edgeId: string;
  dropX: number;
  dropY: number;
  initial: InitialEdgeValues;
  fromTitle: string;
  toTitle: string;
} | null;

// ─── RenameNodeState ──────────────────────────────────────────────────────────

type RenameNodeState = {
  entryId: string;
  currentTitle: string;
} | null;

// ─── ToastState ───────────────────────────────────────────────────────────────

type ToastState = { message: string; variant: 'success' | 'error' } | null;

// ─── Locked copy ─────────────────────────────────────────────────────────────

const COPY = {
  loading: 'Loading diagram...',
  error: "Couldn't load diagram. Refresh the page.",
  selfDropToast: "Can't draw an edge from a node to itself.",
  edgeSaveErrorToast: "Couldn't save edge. Try again.",
  renameLabel: 'Rename',
  renamePlaceholder: 'New name',
  renameSave: 'Save',
  renameCancel: 'Cancel',
} as const;

/**
 * /universes/:uid/diagrams/:did — full-canvas diagram editor.
 *
 * Orchestrates: DiagramToolbar, DiagramCanvas, AddEntriesPicker, DrawEdgePopover, Toast.
 * Data layer: useDiagram + useEntries + node/edge mutation hooks.
 * Undo/redo: session-scoped stack (cap 50), tracks node moves + edge create/delete.
 * Layout mode: Auto-layout dispatches to familyTreeLayout (family-tree) or orgChartLayout
 * (org-chart) per layoutMode state; result applied as a single undoable batch.
 * Export JSON: serializeDiagram → URL.createObjectURL + transient <a download>.
 * Esc priority: 1=close popover, 2=cancel drag (handled in DiagramCanvas), 3=exit edit mode.
 *
 * Reduced motion: relies on existing styles.css prefers-reduced-motion rule.
 * Node drag + auto-layout snap apply NO JS animation (DIAGRAM-05).
 */
export function DiagramEditor() {
  const { uid = '', did = '' } = useParams<{ uid: string; did: string }>();

  // ── Data ───────────────────────────────────────────────────────────────────
  const { data: diagram, isLoading, isError } = useDiagram(uid, did);
  const { data: entriesData } = useEntries(uid);
  const addNode = useAddNode(uid, did);
  const removeNode = useRemoveNode(uid, did);
  const moveNode = useMoveNode(uid, did);
  const createEdge = useCreateEdge(uid, did);
  const deleteEdge = useDeleteEdge(uid, did);
  const updateEdge = useUpdateEdge(uid, did);
  const renameNode = useRenameNode(uid, did);

  // ── UI state ───────────────────────────────────────────────────────────────
  const [editMode, setEditMode] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [layoutMode, setLayoutMode] = useState<LayoutMode>(null);
  const [selection, setSelection] = useState<Set<string>>(new Set());
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const [popoverState, setPopoverState] = useState<PopoverState>(null);
  const [editEdgeState, setEditEdgeState] = useState<EditEdgeState>(null);
  const [renameNodeState, setRenameNodeState] = useState<RenameNodeState>(null);
  const [renameInput, setRenameInput] = useState('');
  const [toast, setToast] = useState<ToastState>(null);
  const [dragSourceId, setDragSourceId] = useState<string | null>(null);

  // ── Undo/redo stack ────────────────────────────────────────────────────────
  // undoStack: array of undoable ops, pointer points to next-undoable index
  const [undoStack, setUndoStack] = useState<UndoableOp[]>([]);
  const [undoPointer, setUndoPointer] = useState(-1); // -1 = nothing to undo

  const pushOp = useCallback((op: UndoableOp) => {
    setUndoStack((prev) => {
      // Discard any "future" ops above the current pointer (redo history cleared on new op)
      const base = prev.slice(0, undoPointer + 1);
      const next = [...base, op];
      // Cap at limit
      if (next.length > UNDO_STACK_LIMIT) {
        return next.slice(next.length - UNDO_STACK_LIMIT);
      }
      return next;
    });
    setUndoPointer((p) => {
      const base = Math.min(p + 1, undoStack.length);
      const capped = Math.min(base, UNDO_STACK_LIMIT - 1);
      return capped;
    });
  }, [undoPointer, undoStack.length]);

  const canUndo = undoPointer >= 0;
  const canRedo = undoPointer < undoStack.length - 1;

  const handleUndo = useCallback(async () => {
    if (!canUndo) return;
    const op = undoStack[undoPointer];
    setUndoPointer((p) => p - 1);
    await applyUndoOp(op, 'undo');
  }, [canUndo, undoPointer, undoStack]);

  const handleRedo = useCallback(async () => {
    if (!canRedo) return;
    const nextPointer = undoPointer + 1;
    const op = undoStack[nextPointer];
    setUndoPointer(nextPointer);
    await applyUndoOp(op, 'redo');
  }, [canRedo, undoPointer, undoStack]);

  // Apply a single undo/redo operation. Node moves restore positions.
  // Edge ops just invalidate the cache (the server is the source of truth).
  const applyUndoOp = async (op: UndoableOp, direction: 'undo' | 'redo') => {
    if (op.type === 'node-move') {
      const { entryId, prevX, prevY, nextX, nextY } = op;
      const x = direction === 'undo' ? prevX : nextX;
      const y = direction === 'undo' ? prevY : nextY;
      await moveNode.mutateAsync({ entryId, x, y });
    } else if (op.type === 'batch') {
      for (const sub of op.ops) {
        const x = direction === 'undo' ? sub.prevX : sub.nextX;
        const y = direction === 'undo' ? sub.prevY : sub.nextY;
        await moveNode.mutateAsync({ entryId: sub.entryId, x, y });
      }
    } else if (op.type === 'edge-create') {
      if (direction === 'undo') {
        await deleteEdge.mutateAsync(op.edgeId);
      }
      // redo of edge-create not supported (would need to re-create, but we
      // don't have all the original data). Redo just leaves the deleted edge gone.
    } else if (op.type === 'edge-delete') {
      if (direction === 'undo') {
        // Restore the edge by re-creating it with original fields
        await createEdge.mutateAsync({
          sourceEntryId: op.edge.sourceEntryId,
          targetEntryId: op.edge.targetEntryId,
          label: op.edge.label ?? undefined,
          lineStyle: op.edge.lineStyle ?? undefined,
          color: op.edge.color ?? undefined,
        });
      }
    }
  };

  // ── Keyboard: Ctrl/Cmd+Z and Ctrl/Cmd+Shift+Z ─────────────────────────────
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (!mod) return;
      if (e.key === 'z' || e.key === 'Z') {
        if (e.shiftKey) {
          e.preventDefault();
          handleRedo();
        } else {
          e.preventDefault();
          handleUndo();
        }
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [handleUndo, handleRedo]);

  // ── Esc closes the Add Entries picker (priority above exit-edit-mode) ──────
  useEffect(() => {
    if (!pickerOpen) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setPickerOpen(false);
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [pickerOpen]);

  // ── Canvas-level Esc: exit edit mode (priority 3) ─────────────────────────
  // Only fires when no popover is open, no drag is in flight, and the picker is closed.
  useEffect(() => {
    if (!editMode || popoverState !== null || editEdgeState !== null || renameNodeState !== null || dragSourceId !== null || pickerOpen) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setEditMode(false);
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [editMode, popoverState, editEdgeState, renameNodeState, dragSourceId, pickerOpen]);

  // ── Build CanvasNodes: join DiagramNode with Entry display fields ──────────
  const canvasNodes = useMemo<CanvasNode[]>(() => {
    if (!diagram?.nodes || !entriesData) return diagram?.nodes?.map((n) => ({
      ...n,
      title: n.entryId,
      entryType: 'concept',
    })) ?? [];
    const entryMap = new Map(entriesData.map((e) => [e.id, e]));
    return diagram.nodes.map((n) => {
      const entry = entryMap.get(n.entryId);
      return {
        ...n,
        title: entry?.title ?? n.entryId,
        entryType: entry?.entryType ?? 'concept',
      };
    });
  }, [diagram?.nodes, entriesData]);

  // ── Placed entry ids for AddEntriesPicker ────────────────────────────────
  const placedEntryIds = useMemo(
    () => new Set(diagram?.nodes?.map((n) => n.entryId) ?? []),
    [diagram?.nodes],
  );

  // ── Universe entries for AddEntriesPicker ────────────────────────────────
  const universalEntries = useMemo(
    () =>
      (entriesData ?? []).map((e) => ({
        id: e.id,
        title: e.title,
        entryType: e.entryType,
      })),
    [entriesData],
  );

  // ── Node add handler ──────────────────────────────────────────────────────
  const handleAddEntry = useCallback(
    (entryId: string) => {
      addNode.mutate({ entryId, x: 200 + Math.random() * 200, y: 200 + Math.random() * 200 });
    },
    [addNode],
  );

  // ── Node remove handler ──────────────────────────────────────────────────
  const handleRemoveEntry = useCallback(
    (entryId: string) => {
      const node = diagram?.nodes.find((n) => n.entryId === entryId);
      if (node) {
        removeNode.mutate(node.id);
      }
    },
    [diagram?.nodes, removeNode],
  );

  // ── Node move handler (tracked for undo) ─────────────────────────────────
  const handleMoveNode = useCallback(
    (entryId: string, x: number, y: number) => {
      // Find previous position for undo
      const prev = diagram?.nodes.find((n) => n.entryId === entryId);
      const prevX = prev?.x ?? x;
      const prevY = prev?.y ?? y;
      moveNode.mutate({ entryId, x, y });
      pushOp({ type: 'node-move', entryId, prevX, prevY, nextX: x, nextY: y });
    },
    [diagram?.nodes, moveNode, pushOp],
  );

  // ── Draw-edge callback from canvas ────────────────────────────────────────
  const handleDrawEdge = useCallback(
    (sourceEntryId: string, targetEntryId: string, dropCoords: DropCoords) => {
      setPopoverState({ sourceEntryId, targetEntryId, dropX: dropCoords.x, dropY: dropCoords.y });
    },
    [],
  );

  // ── Self-drop handler ─────────────────────────────────────────────────────
  const handleSelfDrop = useCallback(() => {
    setToast({ message: COPY.selfDropToast, variant: 'error' });
  }, []);

  // ── Edge popover submit ────────────────────────────────────────────────────
  const handleDrawEdgeSubmit = useCallback(
    async (opts: { label: string; lineStyle: LineStyle; color: string }) => {
      if (!popoverState) return;
      const edge = await createEdge.mutateAsync({
        sourceEntryId: popoverState.sourceEntryId,
        targetEntryId: popoverState.targetEntryId,
        label: opts.label || null,
        lineStyle: opts.lineStyle,
        color: opts.color,
      });
      pushOp({ type: 'edge-create', edgeId: edge.id });
      setPopoverState(null);
    },
    [popoverState, createEdge, pushOp],
  );

  // ── Node selection ────────────────────────────────────────────────────────
  const handleSelectNode = useCallback(
    (id: string | null, addToSelection = false) => {
      if (id === null) {
        setSelection(new Set());
        return;
      }
      setSelection((prev) => {
        if (addToSelection) {
          const next = new Set(prev);
          if (next.has(id)) {
            next.delete(id);
          } else {
            next.add(id);
          }
          return next;
        }
        return new Set([id]);
      });
    },
    [],
  );

  // ── Entry map (used by edit-edge + edit-node + popover title resolution) ──
  const entryMap = useMemo(
    () => new Map((entriesData ?? []).map((e) => [e.id, e])),
    [entriesData],
  );

  // ── Edge selection ─────────────────────────────────────────────────────────
  const handleSelectEdge = useCallback((id: string | null) => {
    setSelectedEdgeId(id);
    if (id !== null) setSelection(new Set());
  }, []);

  // ── Edit-edge affordance: open DrawEdgePopover in edit mode ───────────────
  const handleEditEdge = useCallback(
    (edgeId: string, dropCoords: DropCoords) => {
      const edge = diagram?.edges?.find((e) => e.id === edgeId);
      if (!edge) return;
      const fromEntry = entryMap.get(edge.sourceEntryId);
      const toEntry = entryMap.get(edge.targetEntryId);
      setEditEdgeState({
        edgeId,
        dropX: dropCoords.x,
        dropY: dropCoords.y,
        initial: {
          label: edge.label ?? '',
          lineStyle: (edge.lineStyle as LineStyle) ?? 'solid',
          color: edge.color ?? '#6b7280',
        },
        fromTitle: fromEntry?.title ?? edge.sourceEntryId,
        toTitle: toEntry?.title ?? edge.targetEntryId,
      });
    },
    [diagram?.edges, entryMap],
  );

  // ── Edge-edit submit (routes to useUpdateEdge) ────────────────────────────
  const handleUpdateEdgeSubmit = useCallback(
    async (opts: { label: string; lineStyle: LineStyle; color: string }) => {
      if (!editEdgeState) return;
      await updateEdge.mutateAsync({
        edgeId: editEdgeState.edgeId,
        label: opts.label,
        lineStyle: opts.lineStyle,
        color: opts.color,
      });
      setEditEdgeState(null);
      setSelectedEdgeId(null);
    },
    [editEdgeState, updateEdge],
  );

  // ── Edit-node affordance: open inline rename input ────────────────────────
  const handleEditNode = useCallback(
    (entryId: string) => {
      const entry = entryMap.get(entryId);
      const currentTitle = entry?.title ?? entryId;
      setRenameNodeState({ entryId, currentTitle });
      setRenameInput(currentTitle);
    },
    [entryMap],
  );

  // ── Node rename submit (routes to useRenameNode) ──────────────────────────
  const handleRenameSubmit = useCallback(async () => {
    if (!renameNodeState) return;
    const trimmed = renameInput.trim();
    if (!trimmed || trimmed === renameNodeState.currentTitle) {
      setRenameNodeState(null);
      return;
    }
    await renameNode.mutateAsync({ entryId: renameNodeState.entryId, title: trimmed });
    setRenameNodeState(null);
  }, [renameNodeState, renameInput, renameNode]);

  // ── Auto-layout (mode-aware dispatch) ────────────────────────────────────
  // Dispatches to familyTreeLayout or orgChartLayout based on layoutMode.
  // Both functions accept the same (nodes, edges, opts) signature and return
  // the same Map<string, {x, y}> type — single apply path for both.
  const handleAutoLayout = useCallback(async () => {
    if (!diagram || layoutMode === null) return;
    const layoutEdges = (diagram.edges ?? []).map((e) => ({
      id: e.id,
      source: e.sourceEntryId,
      target: e.targetEntryId,
      label: e.label,
    }));
    const layoutNodes = canvasNodes.map((n) => ({ id: n.entryId, x: n.x, y: n.y }));
    const layoutOpts = { startX: 400, startY: 80 };
    const positions =
      layoutMode === 'org-chart'
        ? orgChartLayout(layoutNodes, layoutEdges, layoutOpts)
        : familyTreeLayout(layoutNodes, layoutEdges, layoutOpts);

    // Build batch op for undo (single batch = one Undo reverts all)
    const batchOps: NodeMoveOp[] = [];
    for (const [entryId, pos] of positions) {
      const prev = diagram.nodes.find((n) => n.entryId === entryId);
      batchOps.push({
        type: 'node-move',
        entryId,
        prevX: prev?.x ?? pos.x,
        prevY: prev?.y ?? pos.y,
        nextX: pos.x,
        nextY: pos.y,
      });
    }

    // Persist all positions
    for (const op of batchOps) {
      await moveNode.mutateAsync({ entryId: op.entryId, x: op.nextX, y: op.nextY });
    }

    pushOp({ type: 'batch', ops: batchOps });
  }, [diagram, layoutMode, canvasNodes, moveNode, pushOp]);

  // ── Export JSON ───────────────────────────────────────────────────────────
  const handleExportJson = useCallback(() => {
    if (!diagram) return;
    const exportEdges = (diagram.edges ?? []).map((e) => ({
      id: e.id,
      source: e.sourceEntryId,
      target: e.targetEntryId,
      label: e.label,
      lineStyle: (e.lineStyle ?? 'solid') as 'solid' | 'dashed' | 'dotted',
      color: e.color ?? '#6b7280',
    }));
    const exportNodes = (diagram.nodes ?? []).map((n) => ({
      id: n.id,
      entryId: n.entryId,
      x: n.x,
      y: n.y,
    }));
    const serialized = serializeDiagram(
      { id: diagram.id, name: diagram.name, description: diagram.description ?? undefined },
      exportNodes,
      exportEdges,
    );
    const blob = new Blob([JSON.stringify(serialized, null, 2)], {
      type: 'application/json',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${diagram.name.replace(/[^a-z0-9]/gi, '_').toLowerCase()}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, [diagram]);

  // ── Find source/target titles for DrawEdgePopover ─────────────────────────
  const sourceTitle = popoverState
    ? (entryMap.get(popoverState.sourceEntryId)?.title ?? popoverState.sourceEntryId)
    : '';
  const targetTitle = popoverState
    ? (entryMap.get(popoverState.targetEntryId)?.title ?? popoverState.targetEntryId)
    : '';

  // ── Render ────────────────────────────────────────────────────────────────

  if (isLoading) {
    return <p className="p-6 text-sm text-neutral-500">{COPY.loading}</p>;
  }

  if (isError || !diagram) {
    return <p className="p-6 text-sm text-red-500">{COPY.error}</p>;
  }

  return (
    <div className="relative h-[calc(100vh-7rem)] w-full overflow-hidden">
      {/* Floating toolbar overlay */}
      <DiagramToolbar
        nodeCount={diagram.nodes?.length ?? 0}
        edgeCount={diagram.edges?.length ?? 0}
        pickerOpen={pickerOpen}
        onTogglePicker={() => setPickerOpen((v) => !v)}
        editMode={editMode}
        onToggleEditMode={() => setEditMode((v) => !v)}
        layoutMode={layoutMode}
        onSetLayoutMode={setLayoutMode}
        onAutoLayout={handleAutoLayout}
        canUndo={canUndo}
        onUndo={handleUndo}
        canRedo={canRedo}
        onRedo={handleRedo}
        onExportJson={handleExportJson}
      />

      {/* Connect-edge discoverability hint — teaches the Edit→drag flow.
          In view mode: how to start. In edit mode: what to do now. */}
      {(diagram.nodes?.length ?? 0) >= 2 && popoverState === null && (
        <div className="pointer-events-none absolute left-1/2 top-14 z-10 -translate-x-1/2 px-3">
          <div
            className={[
              'rounded-full px-3 py-1 text-xs shadow-sm whitespace-nowrap',
              editMode
                ? 'border border-[color:var(--color-accent)] bg-[color:var(--color-accent-soft)] text-[color:var(--color-accent)]'
                : 'border border-neutral-300 bg-white/80 text-neutral-500 dark:border-neutral-700 dark:bg-neutral-900/80 dark:text-neutral-400',
            ].join(' ')}
          >
            {editMode
              ? 'Drag from one node onto another to draw an edge · Esc to exit'
              : 'To connect: click Edit, then drag one node onto another'}
          </div>
        </div>
      )}

      {/* Full-bleed SVG canvas */}
      <DiagramCanvas
        nodes={canvasNodes}
        edges={diagram.edges ?? []}
        selection={selection}
        selectedEdgeId={selectedEdgeId}
        editMode={editMode}
        onDrawEdge={handleDrawEdge}
        onSelfDrop={handleSelfDrop}
        onMoveNode={handleMoveNode}
        onSelectNode={handleSelectNode}
        onSelectEdge={handleSelectEdge}
        onDragSourceChange={setDragSourceId}
        onEditEdge={handleEditEdge}
        onEditNode={handleEditNode}
      />

      {/* AddEntriesPicker — slide-in panel */}
      <AddEntriesPicker
        entries={universalEntries}
        placedEntryIds={placedEntryIds}
        onAdd={handleAddEntry}
        onRemove={handleRemoveEntry}
        onClose={() => setPickerOpen(false)}
        open={pickerOpen}
      />

      {/* DrawEdgePopover — anchored at drop coords (create mode) */}
      {popoverState && (
        <DrawEdgePopover
          open={true}
          onOpenChange={(open) => {
            if (!open) setPopoverState(null);
          }}
          fromTitle={sourceTitle}
          toTitle={targetTitle}
          dropX={popoverState.dropX}
          dropY={popoverState.dropY}
          onSubmit={handleDrawEdgeSubmit}
          onError={() => setToast({ message: COPY.edgeSaveErrorToast, variant: 'error' })}
        />
      )}

      {/* DrawEdgePopover — edit mode: pre-filled with selected edge's current values */}
      {editEdgeState && (
        <DrawEdgePopover
          open={true}
          onOpenChange={(open) => {
            if (!open) setEditEdgeState(null);
          }}
          fromTitle={editEdgeState.fromTitle}
          toTitle={editEdgeState.toTitle}
          dropX={editEdgeState.dropX}
          dropY={editEdgeState.dropY}
          mode="edit"
          initialEdge={editEdgeState.initial}
          onSubmit={handleUpdateEdgeSubmit}
          onError={() => setToast({ message: COPY.edgeSaveErrorToast, variant: 'error' })}
        />
      )}

      {/* Inline rename node input — small floating panel anchored above the canvas */}
      {renameNodeState && (
        <div
          data-testid="rename-node-panel"
          className="absolute left-1/2 top-24 z-30 -translate-x-1/2 flex items-center gap-2 rounded-md border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-900 shadow-lg px-3 py-2"
        >
          <span className="text-xs text-neutral-500 dark:text-neutral-400 shrink-0">
            {COPY.renameLabel}
          </span>
          <input
            data-testid="rename-node-input"
            type="text"
            value={renameInput}
            onChange={(e) => setRenameInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { e.preventDefault(); handleRenameSubmit(); }
              if (e.key === 'Escape') { e.preventDefault(); setRenameNodeState(null); }
            }}
            placeholder={COPY.renamePlaceholder}
            autoFocus
            className="rounded border border-neutral-300 dark:border-neutral-700 bg-transparent px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-[color:var(--color-accent)] w-48"
          />
          <button
            type="button"
            onClick={handleRenameSubmit}
            className="rounded bg-[color:var(--color-accent)] text-white text-xs px-2 py-1"
          >
            {COPY.renameSave}
          </button>
          <button
            type="button"
            onClick={() => setRenameNodeState(null)}
            className="rounded border border-neutral-300 dark:border-neutral-700 text-xs px-2 py-1"
          >
            {COPY.renameCancel}
          </button>
        </div>
      )}

      {/* Toast (bottom-center, same as GraphView) */}
      {toast && (
        <Toast
          message={toast.message}
          variant={toast.variant}
          onDismiss={() => setToast(null)}
          durationMs={3000}
        />
      )}
    </div>
  );
}
