import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import { TimelineCanvas } from '../components/TimelineCanvas';
import { TimelineEntryPanel } from '../components/TimelineEntryPanel';
import { TimelineRangeDialog } from '../components/TimelineRangeDialog';
import { PinPopover } from '../components/PinPopover';
import { Toast } from '../components/Toast';
import { useTimelineWindow } from '../hooks/useTimelineWindow';
import {
  useTimelinePins,
  useUpsertTimelinePin,
  type TimelinePin,
} from '../hooks/useTimelinePins';
import { useCalendar } from '../hooks/useCalendar';
import { xToPos } from '../lib/timelineMath';
import {
  useShareMode,
  useShareCalendar,
  useShareTimelineWindow,
} from '../contexts/ShareModeContext';

type ToastState = { message: string; variant: 'success' | 'error' } | null;

/**
 * Plan 06 popoverState — drives the conditional <PinPopover> render when a
 * panel-card drop lands on the canvas. dropX/dropY are container-relative
 * pixel coords for the popover anchor; position is the timeline-space value
 * computed by inverting the live d3-zoom transform and feeding the result
 * through `xToPos`.
 */
type PopoverState = {
  entryId: string;
  position: number;
  dropX: number;
  dropY: number;
} | null;

const TOAST_ERROR_COPY = "Couldn't save pin. Try again.";

/**
 * /universes/:uid/timeline — horizontal canvas with parallax era layer,
 * drag-from-panel pin creation, and pin-drag reposition (TIMELINE-01..06).
 *
 * Orchestration seams:
 *  - useTimelineWindow → gates the canvas behind TimelineRangeDialog on the
 *    first visit (D-02). When `window === null`, the dialog is mounted open
 *    and the canvas is not rendered.
 *  - useTimelinePins → feeds both the canvas (render) and the entry panel
 *    (Pinned-badge derivation).
 *  - useUpsertTimelinePin → unifies create (drop-from-panel via PinPopover)
 *    and reposition (canvas pin drag end). No new endpoint (D-08).
 *  - DndContext (top-level) → PointerSensor with activationConstraint
 *    distance=5 + KeyboardSensor. handleDragEnd inverts the live d3-zoom
 *    transform stored in `currentTransformRef` (mutated by TimelineCanvas
 *    via the onTransformChange callback — RESEARCH §Q3).
 *  - cancelledRef + per-drag keydown listener → Esc mid-drag sets a flag so
 *    handleDragEnd is a no-op (D-08a parity with the d3-drag Esc-cancel).
 *  - Toast → per-view bridge for popover save failures AND canvas pin-drag
 *    save failures (belt-and-suspenders parity with GraphView).
 *
 * Removed in Plan 06: the vertical grouped-list rendering path (no more
 * groupByEra-based section headers) and the local precisionDotClass helper
 * (lifted to PrecisionBadge in Plan 04).
 */
export function TimelineView() {
  // Phase 29 — share-mode awareness. In share mode the route is
  // `/share/:token/timeline` (no `uid` param); substitute 'share' so
  // useTimelinePins / useTimelineWindow build paths the api-client seam
  // can translate to /api/share/timeline. The `token` drives navigation
  // back into the share subtree on pin click.
  const { uid: paramUid, token } = useParams<{ uid: string; token: string }>();
  const isShareMode = useShareMode();
  const uid = paramUid ?? (isShareMode ? 'share' : undefined);
  const universeId = uid ?? '';
  const navigate = useNavigate();

  // Phase 33 SHARE-02: in share mode useTimelineWindow → useUniverse('share')
  // 404s, so authWindow is null and the timeline renders empty. Use the
  // timelineWindow threaded from the share-meta endpoint via ShareModeContext
  // as the effective window when inside the share subtree (mirrors the calendar
  // fix below). windowLoading is irrelevant in share mode (no query in flight).
  const { window: authWindow, isLoading: windowLoadingAuth } =
    useTimelineWindow(universeId);
  const shareWindow = useShareTimelineWindow();
  const timelineWindow = isShareMode ? shareWindow : authWindow;
  const windowLoading = isShareMode ? false : windowLoadingAuth;
  const { data: pins = [], isLoading: pinsLoading } = useTimelinePins(universeId);
  const upsert = useUpsertTimelinePin(universeId);
  // Phase 30 CALENDAR-02: source the per-universe calendar for date formatting.
  // In authenticated mode, useCalendar reads from useUniverse (/universes/:uid).
  // In share mode, useUniverse 404s for the 'share' sentinel uid and calendar is
  // null — but ShareModeContext now carries the calendar from the share-meta
  // endpoint (Phase 33 INT-BLOCKER-1 fix). Select the effective calendar:
  // share calendar when isShareMode, else the authenticated useCalendar value.
  const { calendar: authCalendar } = useCalendar(universeId);
  const shareCalendar = useShareCalendar();
  const calendar = isShareMode ? shareCalendar : authCalendar;

  const [toast, setToast] = useState<ToastState>(null);
  const [popoverState, setPopoverState] = useState<PopoverState>(null);
  const [rangeDialogOpen, setRangeDialogOpen] = useState(false);
  const [isDndDragActive, setIsDndDragActive] = useState(false);

  const containerRef = useRef<HTMLDivElement>(null);
  const canvasContainerRef = useRef<HTMLDivElement>(null);
  const cancelledRef = useRef(false);
  // Live d3-zoom transform mirrored from TimelineCanvas via onTransformChange.
  // Imperative-only — written per zoom tick from the canvas, read in
  // handleDragEnd for inverse-transform math. Never setState per tick.
  const currentTransformRef = useRef<{ x: number; y: number; k: number }>({
    x: 0,
    y: 0,
    k: 1,
  });
  // Per-drag keydown listener handle — installed at drag start, removed at
  // drag end/cancel (T-20-21: avoid listener leaks across rapid drag cycles).
  const dragKeydownRef = useRef<((e: KeyboardEvent) => void) | null>(null);

  // Responsive canvas sizing — verbatim ResizeObserver-with-jsdom-fallback
  // from GraphView.tsx so the SVG fills the outlet while keeping unit tests
  // (jsdom has no ResizeObserver) deterministic.
  const [size, setSize] = useState({ width: 800, height: 600 });
  useEffect(() => {
    if (!canvasContainerRef.current) return;
    const el = canvasContainerRef.current;
    if (typeof ResizeObserver === 'undefined') {
      const rect = el.getBoundingClientRect();
      setSize({
        width: Math.max(200, rect.width || 800),
        height: Math.max(200, rect.height || 600),
      });
      return;
    }
    const ro = new ResizeObserver(([entry]) => {
      const r = entry.contentRect;
      setSize({
        width: Math.max(200, r.width || 800),
        height: Math.max(200, r.height || 600),
      });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [timelineWindow]);

  // Canvas pin-drag reposition — preserves existing label and precision per
  // RESEARCH §Pitfall 6. On rejection, surfaces an error Toast; TanStack
  // invalidation handles the post-success re-render.
  const handlePinDragEnd = useCallback(
    async (pin: TimelinePin, newPosition: number) => {
      try {
        await upsert.mutateAsync({
          entryId: pin.entryId,
          position: newPosition,
          label: pin.label,
          precision: pin.precision,
        });
      } catch {
        setToast({ message: TOAST_ERROR_COPY, variant: 'error' });
      }
    },
    [upsert],
  );

  // @dnd-kit sensors (per plan): PointerSensor with activationConstraint
  // distance=5 (RESEARCH §Q3 — disambiguates click vs drag) + KeyboardSensor
  // for accessibility.
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor),
  );

  const removeDragKeydown = useCallback(() => {
    if (dragKeydownRef.current) {
      window.removeEventListener('keydown', dragKeydownRef.current);
      dragKeydownRef.current = null;
    }
  }, []);

  const handleDragStart = useCallback(() => {
    cancelledRef.current = false;
    setIsDndDragActive(true);
    // Esc mid-@dnd-kit-drag → set the cancel flag so handleDragEnd is a no-op.
    // Mirrors the Phase 19 cancelledRef pattern (RESEARCH §Q3 §Esc-cancel).
    removeDragKeydown();
    const handler = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      cancelledRef.current = true;
    };
    dragKeydownRef.current = handler;
    window.addEventListener('keydown', handler);
  }, [removeDragKeydown]);

  const handleDragCancel = useCallback(() => {
    cancelledRef.current = true;
    setIsDndDragActive(false);
    removeDragKeydown();
  }, [removeDragKeydown]);

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      setIsDndDragActive(false);
      removeDragKeydown();
      const wasCancelled = cancelledRef.current;
      cancelledRef.current = false;
      if (wasCancelled) return;
      if (!timelineWindow) return;
      if (!event.active) return;

      // Compute drop client coords from @dnd-kit's activatorEvent + delta.
      // activatorEvent is the original PointerDown event; delta is the
      // translation from drag start to drag end in client space.
      const activator = event.activatorEvent as
        | { clientX?: number; clientY?: number }
        | undefined;
      const clientX = (activator?.clientX ?? 0) + event.delta.x;
      const clientY = (activator?.clientY ?? 0) + event.delta.y;

      const canvasEl = canvasContainerRef.current;
      if (!canvasEl) return;
      const rect = canvasEl.getBoundingClientRect();
      // Canvas-local pixel coords (origin at the canvas's top-left).
      const canvasX = clientX - rect.left;
      const canvasY = clientY - rect.top;
      // Invert the live d3-zoom transform: pinLayer.attr('transform',
      // `translate(${t.x}, ${t.y}) scale(${t.k})`), so the inverse mapping is
      // svgX = (canvasX - t.x) / t.k.
      const t = currentTransformRef.current;
      const svgX = (canvasX - t.x) / t.k;
      const position = xToPos(
        svgX,
        timelineWindow.start,
        timelineWindow.end,
        size.width,
      );
      // Container-relative coords for the popover anchor.
      const containerRect = containerRef.current?.getBoundingClientRect();
      const dropX = clientX - (containerRect?.left ?? 0);
      const dropY = clientY - (containerRect?.top ?? 0);

      setPopoverState({
        entryId: String(event.active.id),
        position,
        dropX,
        dropY,
      });
    },
    [removeDragKeydown, timelineWindow, size.width],
  );

  // Tear down the per-drag keydown listener if the component unmounts mid-drag.
  useEffect(() => removeDragKeydown, [removeDragKeydown]);

  if (windowLoading || pinsLoading) {
    return <p className="p-6 text-sm text-neutral-500">Loading…</p>;
  }

  // First-visit gate (D-02): no window persisted → mount the configure-range
  // dialog open; the canvas is NOT rendered behind it. Closing without saving
  // leaves window=null and the dialog re-mounts on the next visit (no nagging
  // mid-session because onOpenChange is a no-op here).
  //
  // Phase 29 — share-mode visitors never see the configure dialog (D-18
  // mutation surface). Instead, render a friendly empty state explaining
  // the owner hasn't configured a timeline yet.
  if (!timelineWindow) {
    if (isShareMode) {
      return (
        <div className="max-w-3xl mx-auto p-6">
          <h1 className="text-2xl font-semibold tracking-tight">Timeline</h1>
          <p className="mt-4 text-sm text-neutral-600 dark:text-neutral-400">
            No timeline is available for this universe yet.
          </p>
        </div>
      );
    }
    return (
      <div ref={containerRef} className="flex h-full flex-col">
        <TimelineRangeDialog
          open
          onOpenChange={() => {
            /* first-visit gate: stay open until a window is saved */
          }}
          universeId={universeId}
        />
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      className="relative flex h-[calc(100vh-7rem)] w-full flex-col overflow-hidden"
    >
      <DndContext
        sensors={sensors}
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
        onDragCancel={handleDragCancel}
      >
        <header className="flex items-center justify-between px-6 pt-6 pb-3">
          <h1 className="text-2xl font-semibold">Timeline</h1>
          {/* Phase 29 D-18 — Configure range is owner-only. */}
          {!isShareMode && (
            <button
              type="button"
              onClick={() => setRangeDialogOpen(true)}
              className="rounded-md border border-neutral-300 bg-white/80 px-3 py-1.5 text-sm shadow-sm hover:bg-white dark:border-neutral-700 dark:bg-neutral-900/80 dark:text-neutral-100 dark:hover:bg-neutral-900"
            >
              Configure range
            </button>
          )}
        </header>
        <div className="flex min-h-0 flex-1">
          <div ref={canvasContainerRef} className="relative flex-1">
            <TimelineCanvas
              universeId={universeId}
              pins={pins}
              window={timelineWindow}
              width={size.width}
              height={size.height}
              calendar={calendar}
              // Phase 33 — in share mode pins are read-only and must NOT be
              // draggable: attaching d3-drag suppresses the trailing click and
              // breaks the visitor's "CLICK TO OPEN" → entry navigation.
              pinsDraggable={!isShareMode}
              // Phase 29 — share-mode pin drag is suppressed (no save
              // mutation); pass a no-op handler so the canvas-level
              // d3-drag does not call the upsert mutation.
              onPinDragEnd={
                isShareMode ? async () => undefined : handlePinDragEnd
              }
              onPinClick={(pin) => {
                navigate(
                  isShareMode
                    ? `/share/${token ?? ''}/entries/${pin.entryId}`
                    : `/universes/${universeId}/entries/${pin.entryId}`,
                );
              }}
              onTransformChange={(t) => {
                currentTransformRef.current = t;
              }}
              isDndDragActive={isDndDragActive}
            />
          </div>
          {/*
            Phase 29 — TimelineEntryPanel is the drag-from-list source for
            new pin creation (visitor must not have it). The pin list is
            still visible inside the timeline canvas itself; the panel is
            a creation surface, not a reading surface.
          */}
          {!isShareMode && (
            <TimelineEntryPanel universeId={universeId} pins={pins} />
          )}
        </div>
      </DndContext>

      {rangeDialogOpen && !isShareMode && (
        <TimelineRangeDialog
          open={rangeDialogOpen}
          onOpenChange={setRangeDialogOpen}
          universeId={universeId}
        />
      )}

      {popoverState && !isShareMode && (
        <PinPopover
          universeId={universeId}
          open
          onOpenChange={(open) => {
            if (!open) setPopoverState(null);
          }}
          entryId={popoverState.entryId}
          dropX={popoverState.dropX}
          dropY={popoverState.dropY}
          initialPosition={popoverState.position}
          onError={() =>
            setToast({ message: TOAST_ERROR_COPY, variant: 'error' })
          }
        />
      )}

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
