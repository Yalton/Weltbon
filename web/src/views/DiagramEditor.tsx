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
import { exportSvg, exportPng } from '../lib/diagramImageExport';
import { alignNodes, distributeNodes, type AlignEdge } from '../lib/diagramAlign';
import type { CanvasNode } from '../components/DiagramCanvas';
import type { DiagramNode, DiagramEdge } from '../hooks/useDiagram';
import type { LayoutMode } from '../components/DiagramToolbar';


const UNDO_STACK_LIMIT = 50;


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


type PopoverState = {
  sourceEntryId: string;
  targetEntryId: string;
  dropX: number;
  dropY: number;
} | null;


type EditEdgeState = {
  edgeId: string;
  dropX: number;
  dropY: number;
  initial: InitialEdgeValues;
  fromTitle: string;
  toTitle: string;
} | null;


type RenameNodeState = {
  entryId: string;
  currentTitle: string;
} | null;


type ToastState = { message: string; variant: 'success' | 'error' } | null;


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

export function DiagramEditor() {
  const { uid = '', did = '' } = useParams<{ uid: string; did: string }>();

  const { data: diagram, isLoading, isError } = useDiagram(uid, did);
  const { data: entriesData } = useEntries(uid);
  const addNode = useAddNode(uid, did);
  const removeNode = useRemoveNode(uid, did);
  const moveNode = useMoveNode(uid, did);
  const createEdge = useCreateEdge(uid, did);
  const deleteEdge = useDeleteEdge(uid, did);
  const updateEdge = useUpdateEdge(uid, did);
  const renameNode = useRenameNode(uid, did);

  // WR-07: widened to SVGSVGElement | null to match the honest handle type from
  const canvasSvgRef = useRef<SVGSVGElement | null>(null);

  const [editMode, setEditMode] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [layoutMode, setLayoutMode] = useState<LayoutMode>(null);
  const [snapEnabled, setSnapEnabled] = useState(false);
  const [selection, setSelection] = useState<Set<string>>(new Set());
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const [popoverState, setPopoverState] = useState<PopoverState>(null);
  const [editEdgeState, setEditEdgeState] = useState<EditEdgeState>(null);
  const [renameNodeState, setRenameNodeState] = useState<RenameNodeState>(null);
  const [renameInput, setRenameInput] = useState('');
  const [toast, setToast] = useState<ToastState>(null);
  const [dragSourceId, setDragSourceId] = useState<string | null>(null);

  // undoStack: array of undoable ops, pointer points to next-undoable index
  const [undoStack, setUndoStack] = useState<UndoableOp[]>([]);
  const [undoPointer, setUndoPointer] = useState(-1); // -1 = nothing to undo

  // the authoritative pointer without a stale closure (CR-01 fix).
  const undoPointerRef = useRef(-1);
  useEffect(() => {
    undoPointerRef.current = undoPointer;
  });

  const pushOp = useCallback((op: UndoableOp) => {
    // CR-01: derive both the new stack AND the new pointer inside a single
    // two stale closures that can diverge on cap overflow or redo-trim.
    setUndoStack((prev) => {
      const base = prev.slice(0, undoPointerRef.current + 1);
      let next = [...base, op];
      if (next.length > UNDO_STACK_LIMIT) {
        next = next.slice(next.length - UNDO_STACK_LIMIT);
      }
      // Update the pointer to the top of the freshly-built stack (inside same updater)
      setUndoPointer(next.length - 1);
      return next;
    });
  }, []);

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
  useEffect(() => {
    if (!editMode || popoverState !== null || editEdgeState !== null || renameNodeState !== null || dragSourceId !== null || pickerOpen) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setEditMode(false);
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [editMode, popoverState, editEdgeState, renameNodeState, dragSourceId, pickerOpen]);

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

  const placedEntryIds = useMemo(
    () => new Set(diagram?.nodes?.map((n) => n.entryId) ?? []),
    [diagram?.nodes],
  );

  const universalEntries = useMemo(
    () =>
      (entriesData ?? []).map((e) => ({
        id: e.id,
        title: e.title,
        entryType: e.entryType,
      })),
    [entriesData],
  );

  const handleAddEntry = useCallback(
    (entryId: string) => {
      addNode.mutate({ entryId, x: 200 + Math.random() * 200, y: 200 + Math.random() * 200 });
    },
    [addNode],
  );

  const handleRemoveEntry = useCallback(
    (entryId: string) => {
      const node = diagram?.nodes.find((n) => n.entryId === entryId);
      if (node) {
        removeNode.mutate(node.id);
      }
    },
    [diagram?.nodes, removeNode],
  );

  // CR-02: Accept prevX/prevY from DiagramCanvas (captured at drag-start) instead
  // of reconstructing them from the React-Query cache, which may already reflect
  // an in-flight optimistic update, causing undo to be a no-op.
  const handleMoveNode = useCallback(
    (entryId: string, prevX: number, prevY: number, x: number, y: number) => {
      moveNode.mutate({ entryId, x, y });
      pushOp({ type: 'node-move', entryId, prevX, prevY, nextX: x, nextY: y });
    },
    [moveNode, pushOp],
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

    // WR-06: persist all positions with failure rollback tracking.
    const succeededOps: NodeMoveOp[] = [];
    try {
      for (const op of batchOps) {
        await moveNode.mutateAsync({ entryId: op.entryId, x: op.nextX, y: op.nextY });
        succeededOps.push(op);
      }
    } catch {
      setToast({ message: "Layout partially applied — some nodes couldn't be saved. Try again.", variant: 'error' });
    }
    if (succeededOps.length > 0) {
      pushOp({ type: 'batch', ops: succeededOps });
    }
  }, [diagram, layoutMode, canvasNodes, moveNode, pushOp]);

  // ── Align/distribute (single-undoable-batch path — same as Auto-layout) ───
  // Takes the current multi-selection, applies alignNodes / distributeNodes,
  // so one Undo restores all pre-align positions. DIAGRAM-01/03.
  const handleAlign = useCallback(
    async (edge: AlignEdge) => {
      if (!diagram || selection.size < 2) return;
      const selectedNodes = canvasNodes.filter((n) => selection.has(n.entryId));
      const inputNodes = selectedNodes.map((n) => ({
        id: n.entryId,
        x: n.x,
        y: n.y,
      }));
      const newPositions = alignNodes(inputNodes, edge);

      const batchOps: NodeMoveOp[] = [];
      for (const [entryId, pos] of newPositions) {
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

      // WR-06: persist with failure tracking — only push successfully applied ops.
      const succeededOps: NodeMoveOp[] = [];
      try {
        for (const op of batchOps) {
          await moveNode.mutateAsync({ entryId: op.entryId, x: op.nextX, y: op.nextY });
          succeededOps.push(op);
        }
      } catch {
        setToast({ message: "Align partially applied — some nodes couldn't be saved. Try again.", variant: 'error' });
      }
      if (succeededOps.length > 0) {
        pushOp({ type: 'batch', ops: succeededOps });
      }
    },
    [diagram, selection, canvasNodes, moveNode, pushOp],
  );

  const handleDistribute = useCallback(
    async (axis: 'horizontal' | 'vertical') => {
      if (!diagram || selection.size < 3) return;
      const selectedNodes = canvasNodes.filter((n) => selection.has(n.entryId));
      const inputNodes = selectedNodes.map((n) => ({
        id: n.entryId,
        x: n.x,
        y: n.y,
      }));
      const newPositions = distributeNodes(inputNodes, axis);

      const batchOps: NodeMoveOp[] = [];
      for (const [entryId, pos] of newPositions) {
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

      // WR-06: persist with failure tracking — only push successfully applied ops.
      const succeededOps: NodeMoveOp[] = [];
      try {
        for (const op of batchOps) {
          await moveNode.mutateAsync({ entryId: op.entryId, x: op.nextX, y: op.nextY });
          succeededOps.push(op);
        }
      } catch {
        setToast({ message: "Distribute partially applied — some nodes couldn't be saved. Try again.", variant: 'error' });
      }
      if (succeededOps.length > 0) {
        pushOp({ type: 'batch', ops: succeededOps });
      }
    },
    [diagram, selection, canvasNodes, moveNode, pushOp],
  );

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

  const handleExportSvg = useCallback(() => {
    if (!diagram || !canvasSvgRef.current) return;
    exportSvg(canvasSvgRef.current, diagram.name, () => {
      setToast({ message: 'Export failed. Try again.', variant: 'error' });
    });
  }, [diagram]);

  const handleExportPng = useCallback(() => {
    if (!diagram || !canvasSvgRef.current) return;
    exportPng(canvasSvgRef.current, diagram.name, {
      onError: () => {
        setToast({ message: 'Export failed. Try again.', variant: 'error' });
      },
    });
  }, [diagram]);

  const sourceTitle = popoverState
    ? (entryMap.get(popoverState.sourceEntryId)?.title ?? popoverState.sourceEntryId)
    : '';
  const targetTitle = popoverState
    ? (entryMap.get(popoverState.targetEntryId)?.title ?? popoverState.targetEntryId)
    : '';


  if (isLoading) {
    return <p className="p-6 text-sm text-ink-muted">{COPY.loading}</p>;
  }

  if (isError || !diagram) {
    return <p className="p-6 text-sm text-red-500">{COPY.error}</p>;
  }

  return (
    <div className="relative h-full w-full overflow-hidden">
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
        onExportSvg={handleExportSvg}
        onExportPng={handleExportPng}
        snapEnabled={snapEnabled}
        onToggleSnap={() => setSnapEnabled((v) => !v)}
        selectionCount={selection.size}
        onAlignLeft={() => handleAlign('left')}
        onAlignRight={() => handleAlign('right')}
        onAlignTop={() => handleAlign('top')}
        onAlignBottom={() => handleAlign('bottom')}
        onCenterH={() => handleAlign('center-x')}
        onCenterV={() => handleAlign('center-y')}
        onDistributeH={() => handleDistribute('horizontal')}
        onDistributeV={() => handleDistribute('vertical')}
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
                : 'border border-line-strong bg-panel text-ink-secondary',
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
        ref={canvasSvgRef}
        nodes={canvasNodes}
        edges={diagram.edges ?? []}
        selection={selection}
        selectedEdgeId={selectedEdgeId}
        editMode={editMode}
        snapEnabled={snapEnabled}
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
          className="absolute left-1/2 top-24 z-30 -translate-x-1/2 flex items-center gap-2 rounded-md border border-line-strong bg-panel shadow-lg px-3 py-2"
        >
          <span className="text-xs text-ink-secondary shrink-0">
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
            className="rounded border border-line-strong bg-transparent px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-[color:var(--color-accent)] w-48"
          />
          <button
            type="button"
            onClick={handleRenameSubmit}
            className="rounded btn-accent text-xs px-2 py-1"
          >
            {COPY.renameSave}
          </button>
          <button
            type="button"
            onClick={() => setRenameNodeState(null)}
            className="rounded border border-line-strong text-xs px-2 py-1"
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
