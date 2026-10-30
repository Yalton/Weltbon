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
import { useEntryMedallions } from '../hooks/useEntryMedallions';
import { xToPos } from '../lib/timelineMath';
import {
  useShareMode,
  useShareCalendar,
  useShareTimelineWindow,
} from '../contexts/ShareModeContext';
import { Loading } from '../components/ui/Loading';

type ToastState = { message: string; variant: 'success' | 'error' } | null;

type PopoverState = {
  entryId: string;
  position: number;
  dropX: number;
  dropY: number;
} | null;

const TOAST_ERROR_COPY = "Couldn't save pin. Try again.";

export function TimelineView() {
  // useTimelinePins / useTimelineWindow build paths the api-client seam
  const { uid: paramUid, token } = useParams<{ uid: string; token: string }>();
  const isShareMode = useShareMode();
  const uid = paramUid ?? (isShareMode ? 'share' : undefined);
  const universeId = uid ?? '';
  const navigate = useNavigate();

  // timelineWindow threaded from the share-meta endpoint via ShareModeContext
  const { window: authWindow, isLoading: windowLoadingAuth } =
    useTimelineWindow(universeId);
  const shareWindow = useShareTimelineWindow();
  const timelineWindow = isShareMode ? shareWindow : authWindow;
  const windowLoading = isShareMode ? false : windowLoadingAuth;
  const { data: pins = [], isLoading: pinsLoading } = useTimelinePins(universeId);
  const upsert = useUpsertTimelinePin(universeId);
  // null — but ShareModeContext now carries the calendar from the share-meta
  const { calendar: authCalendar } = useCalendar(universeId);
  const shareCalendar = useShareCalendar();
  const calendar = isShareMode ? shareCalendar : authCalendar;
  // Content-Forward Views §6 — pin medallions. The /timeline/pins projection carries no
  // included: the api-client seam rewrites the path).
  const medallions = useEntryMedallions(universeId);

  const [toast, setToast] = useState<ToastState>(null);
  const [popoverState, setPopoverState] = useState<PopoverState>(null);
  const [rangeDialogOpen, setRangeDialogOpen] = useState(false);
  const [firstVisitDialogOpen, setFirstVisitDialogOpen] = useState(true);
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
    return <Loading />;
  }

  // First-visit gate (D-02): no window persisted → mount the configure-range
  // leaves window=null and the dialog re-mounts on the next visit (no nagging
  // mid-session because onOpenChange is a no-op here).
  if (!timelineWindow) {
    if (isShareMode) {
      return (
        <div className="max-w-3xl mx-auto p-6">
          <h1 className="text-2xl font-semibold tracking-tight">Timeline</h1>
          <p className="mt-4 text-sm text-ink-secondary">
            No timeline is available for this universe yet.
          </p>
        </div>
      );
    }
    return (
      <div ref={containerRef} className="flex h-full flex-col">
        <div className="max-w-3xl mx-auto p-6">
          <h1 className="text-2xl font-semibold tracking-tight">Timeline</h1>
          <p className="mt-4 text-sm text-ink-secondary">
            This universe doesn&rsquo;t have a timeline range yet. Set a start and
            end position to start placing events on it.
          </p>
          <button
            type="button"
            onClick={() => setFirstVisitDialogOpen(true)}
            className="mt-4 rounded-md bg-[color:var(--color-accent)] text-white text-sm px-3 py-1.5"
          >
            Configure timeline
          </button>
        </div>
        <TimelineRangeDialog
          open={firstVisitDialogOpen}
          onOpenChange={setFirstVisitDialogOpen}
          universeId={universeId}
        />
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      className="relative flex h-full w-full flex-col overflow-hidden"
    >
      <DndContext
        sensors={sensors}
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
        onDragCancel={handleDragCancel}
      >
        <header className="flex items-center justify-between px-6 pt-6 pb-3">
          <h1 className="text-2xl font-semibold">Timeline</h1>

          {!isShareMode && (
            <button
              type="button"
              onClick={() => setRangeDialogOpen(true)}
              className="rounded-md border px-3 py-1.5 text-sm shadow-sm border-line-strong bg-panel text-ink hover:bg-white/[0.03]"
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
              medallions={medallions}
              // draggable: attaching d3-drag suppresses the trailing click and
              pinsDraggable={!isShareMode}
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
