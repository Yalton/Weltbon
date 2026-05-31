import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { AddEntriesPicker } from '../components/AddEntriesPicker';
import { DiagramCanvas, type DropCoords } from '../components/DiagramCanvas';
import { DiagramToolbar } from '../components/DiagramToolbar';
import { DrawEdgePopover, type LineStyle } from '../components/DrawEdgePopover';
import { Toast } from '../components/Toast';
import {
  useDiagram,
  useAddNode,
  useRemoveNode,
  useMoveNode,
  useCreateEdge,
  useDeleteEdge,
} from '../hooks/useDiagram';
import { useEntries } from '../hooks/useEntries';
import { familyTreeLayout } from '../lib/familyTreeLayout';
import { serializeDiagram } from '../lib/diagramExport';
import type { CanvasNode } from '../components/DiagramCanvas';
import type { DiagramNode, DiagramEdge } from '../hooks/useDiagram';

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

// ─── ToastState ───────────────────────────────────────────────────────────────

type ToastState = { message: string; variant: 'success' | 'error' } | null;

// ─── Locked copy ─────────────────────────────────────────────────────────────

const COPY = {
  loading: 'Loading diagram...',
  error: "Couldn't load diagram. Refresh the page.",
  selfDropToast: "Can't draw an edge from a node to itself.",
  edgeSaveErrorToast: "Couldn't save edge. Try again.",
} as const;

/**
 * /universes/:uid/diagrams/:did — full-canvas diagram editor.
 *
 * Orchestrates: DiagramToolbar, DiagramCanvas, AddEntriesPicker, DrawEdgePopover, Toast.
 * Data layer: useDiagram + useEntries + node/edge mutation hooks.
 * Undo/redo: session-scoped stack (cap 50), tracks node moves + edge create/delete.
 * Family tree mode: Auto-layout applies familyTreeLayout as a single undoable batch.
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

  // ── UI state ───────────────────────────────────────────────────────────────
  const [editMode, setEditMode] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [familyTreeMode, setFamilyTreeMode] = useState(false);
  const [selection, setSelection] = useState<Set<string>>(new Set());
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const [popoverState, setPopoverState] = useState<PopoverState>(null);
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

  // ── Canvas-level Esc: exit edit mode (priority 3) ─────────────────────────
  // Only fires when no popover is open and no drag is in flight.
  useEffect(() => {
    if (!editMode || popoverState !== null || dragSourceId !== null) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setEditMode(false);
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [editMode, popoverState, dragSourceId]);

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

  // ── Edge selection ─────────────────────────────────────────────────────────
  const handleSelectEdge = useCallback((id: string | null) => {
    setSelectedEdgeId(id);
    if (id !== null) setSelection(new Set());
  }, []);

  // ── Auto-layout (family tree mode) ───────────────────────────────────────
  const handleAutoLayout = useCallback(async () => {
    if (!diagram) return;
    const layoutEdges = (diagram.edges ?? []).map((e) => ({
      id: e.id,
      source: e.sourceEntryId,
      target: e.targetEntryId,
      label: e.label,
    }));
    const layoutNodes = canvasNodes.map((n) => ({ id: n.entryId, x: n.x, y: n.y }));
    const positions = familyTreeLayout(layoutNodes, layoutEdges, {
      startX: 400,
      startY: 80,
    });

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
  }, [diagram, canvasNodes, moveNode, pushOp]);

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
  const entryMap = useMemo(
    () => new Map((entriesData ?? []).map((e) => [e.id, e])),
    [entriesData],
  );
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
        familyTreeMode={familyTreeMode}
        onToggleFamilyTreeMode={() => setFamilyTreeMode((v) => !v)}
        onAutoLayout={handleAutoLayout}
        canUndo={canUndo}
        onUndo={handleUndo}
        canRedo={canRedo}
        onRedo={handleRedo}
        onExportJson={handleExportJson}
      />

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
      />

      {/* AddEntriesPicker — slide-in panel */}
      <AddEntriesPicker
        entries={universalEntries}
        placedEntryIds={placedEntryIds}
        onAdd={handleAddEntry}
        onRemove={handleRemoveEntry}
        open={pickerOpen}
      />

      {/* DrawEdgePopover — anchored at drop coords */}
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
