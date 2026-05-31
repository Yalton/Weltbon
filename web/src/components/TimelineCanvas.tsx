import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { drag } from 'd3-drag';
import { select } from 'd3-selection';
import { zoom, zoomIdentity, type ZoomBehavior } from 'd3-zoom';
import { posToX, xToPos, clampedPosToX } from '../lib/timelineMath';
import { inferEraSpans, type EraSpan } from '../lib/groupByEra';
import { entryTypeHexColor } from '../lib/entryTypeColor';
import type { TimelinePin } from '../hooks/useTimelinePins';
import { formatCalendar, type Calendar } from '../lib/calendarFormat';

/**
 * Fixed parallax scroll-rate ratio between the era-layer and the pin-layer
 * x-translation (CONTEXT.md §D-06). The era-layer translates at 0.5x the
 * pin-layer's transform.x; both scale at the same k. Not user-configurable.
 */
const PARALLAX_RATIO = 0.5;

/** Pin circle radius in SVG units at k=1 (12px diameter per UI-SPEC §Spacing). */
const PIN_RADIUS = 6;

/** Vertical offset between stacked pins at the same numeric position. */
const STACK_OFFSET = 40;

/** Screen-space distance at which proximity name labels fully fade in. */
const HOVER_RADIUS = 14;
/** Screen-space distance beyond which proximity name labels are hidden. */
const PROXIMITY_THRESHOLD = 110;

const POSITION_FORMAT = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 });

export interface TimelineCanvasProps {
  universeId: string;
  pins: TimelinePin[];
  window: { start: number; end: number };
  width: number;
  height: number;
  /**
   * Per-universe fictional calendar (CALENDAR-02). When non-null, position
   * labels and hover popovers render the compact calendar date string instead
   * of the raw numeric value. When null, falls back to raw numeric (CALENDAR-03).
   */
  calendar: Calendar | null;
  /** Click handler — fires on pin click without modifier keys. */
  onPinClick?: (pin: TimelinePin) => void;
  /**
   * Fires at d3-drag `end` (pointer-up) with the translated new position.
   * NOT fired if the drag was cancelled mid-flight via Esc (D-08a).
   */
  onPinDragEnd?: (pin: TimelinePin, newPosition: number) => void;
  /**
   * Lifecycle callback surfaced to the parent — fires with the pin id on
   * drag start and with `null` on drag end OR Esc cancel. Used by the
   * orchestrator (Plan 06) to gate its own Esc handler.
   */
  onDragSourceChange?: (pinId: string | null) => void;
  /**
   * True while an @dnd-kit panel-card drag is in flight. Disables d3-zoom
   * pan/zoom so the cross-component drag doesn't fight the canvas (RESEARCH
   * §Pattern 3).
   */
  isDndDragActive?: boolean;
  /**
   * Live d3-zoom transform surfaced to the parent so the orchestrator (Plan
   * 06 TimelineView) can invert the transform when translating @dnd-kit drop
   * coords to canvas-space position math (RESEARCH §Q3). Fires on every zoom
   * tick — handlers should write to a ref, not setState.
   */
  onTransformChange?: (transform: { x: number; y: number; k: number }) => void;
}

interface RenderedPin {
  pin: TimelinePin;
  x: number;
  cy: number;
  clamped: boolean;
  clampSide: 'before' | 'after' | null;
}

interface RenderedSpan {
  span: EraSpan;
  x: number;
  width: number;
}

/**
 * SVG canvas with two parallel layers (era-layer behind, pin-layer in front),
 * d3-zoom pan/zoom, d3-drag pin reposition with Esc cancel, vertical stacking
 * at duplicate positions, and out-of-range edge clamping with chevron
 * indicators (D-03).
 *
 * Imperative DOM writes inside zoom/drag handlers — never setState per tick
 * (RESEARCH §Pitfall 1). React owns the data-join shape; d3 owns transform
 * updates on the live element selections.
 */
export function TimelineCanvas({
  universeId: _universeId,
  pins,
  window: timelineWindow,
  width,
  height,
  calendar,
  onPinClick,
  onPinDragEnd,
  onDragSourceChange,
  isDndDragActive,
  onTransformChange,
}: TimelineCanvasProps) {
  const svgRef = useRef<SVGSVGElement>(null);

  // Mirrored callback refs so the main effect's dep list stays stable across
  // parent re-renders that hand new arrow-function identities.
  const onPinClickRef = useRef(onPinClick);
  const onPinDragEndRef = useRef(onPinDragEnd);
  const onDragSourceChangeRef = useRef(onDragSourceChange);
  const onTransformChangeRef = useRef(onTransformChange);
  useEffect(() => {
    onPinClickRef.current = onPinClick;
    onPinDragEndRef.current = onPinDragEnd;
    onDragSourceChangeRef.current = onDragSourceChange;
    onTransformChangeRef.current = onTransformChange;
  });

  // Esc-cancel mid-drag (D-08a): set by the keydown listener installed at
  // drag start, read by the d3-drag `end` handler to skip the onPinDragEnd
  // emission.
  const cancelledRef = useRef(false);
  // Mirrors isDndDragActive so the d3-zoom filter (which is captured at setup
  // time) sees the live value without re-binding the zoom behavior.
  const isDndDragActiveRef = useRef(!!isDndDragActive);
  useEffect(() => {
    isDndDragActiveRef.current = !!isDndDragActive;
  }, [isDndDragActive]);

  // Latest d3-zoom transform — exposed for orchestrator-side coordinate
  // inversion (Plan 06 drop math) and used by the Esc-to-home reset.
  const zoomBehaviorRef = useRef<ZoomBehavior<SVGSVGElement, unknown> | null>(null);
  // Local mirror of the d3-zoom transform — used for cursor-to-pin proximity
  // calc on pointermove. Kept in a ref (not state) so zoom ticks don't trigger
  // React re-renders (RESEARCH §Pitfall 1).
  const transformRef = useRef({ x: 0, y: 0, k: 1 });

  // Cursor in SVG-container screen coords + currently-hovered pin id, both for
  // the proximity name labels and the hover popover.
  const [cursor, setCursor] = useState<{ x: number; y: number } | null>(null);
  const [hoveredPinId, setHoveredPinId] = useState<string | null>(null);

  // Pre-compute the render data outside the d3 effect so the JSX can also
  // assert structure synchronously on first paint (jsdom needs this — d3
  // imperative writes happen in a useEffect that's a tick behind render).
  const baselineY = height / 2;

  // Stack index per position: pins.length=N at the same position become
  // 0..N-1 stack indices, rendered upward from the baseline.
  const stackIndexByPin = new Map<string, number>();
  const stackSeen = new Map<number, number>();
  for (const p of pins) {
    const next = stackSeen.get(p.position) ?? 0;
    stackIndexByPin.set(p.id, next);
    stackSeen.set(p.position, next + 1);
  }

  const renderedPins: RenderedPin[] = pins.map((p) => {
    const { x, clamped } = clampedPosToX(
      p.position,
      timelineWindow.start,
      timelineWindow.end,
      width,
    );
    const stackIndex = stackIndexByPin.get(p.id) ?? 0;
    const cy = baselineY - STACK_OFFSET * stackIndex;
    const clampSide: 'before' | 'after' | null = clamped
      ? p.position < timelineWindow.start
        ? 'before'
        : 'after'
      : null;
    return { pin: p, x, cy, clamped, clampSide };
  });

  // Era span rendering uses the already-sorted-by-server timeline list; if a
  // caller passes unsorted, the math still produces correct spans because
  // inferEraSpans iterates in input order (caller contract documented).
  const spans = inferEraSpans(pins, timelineWindow.end).filter(
    (s) => s.endPos > s.startPos, // drop zero-width spans (back-to-back eras)
  );
  const renderedSpans: RenderedSpan[] = spans.map((s) => {
    const xStart = posToX(s.startPos, timelineWindow.start, timelineWindow.end, width);
    const xEnd = posToX(s.endPos, timelineWindow.start, timelineWindow.end, width);
    return { span: s, x: xStart, width: Math.max(0, xEnd - xStart) };
  });

  // d3-zoom + d3-drag wiring. Runs once per [pins, window, width, height]
  // change and tears down listeners on cleanup.
  useEffect(() => {
    if (!svgRef.current) return;
    const svg = select(svgRef.current);
    const eraLayer = svg.select<SVGGElement>('g.era-layer');
    const pinLayer = svg.select<SVGGElement>('g.pin-layer');
    const pinSel = pinLayer
      .select<SVGGElement>('g.pins')
      .selectAll<SVGCircleElement, RenderedPin>('circle[data-pin-id]');

    const prefersReducedMotion =
      typeof globalThis.matchMedia === 'function' &&
      globalThis.matchMedia('(prefers-reduced-motion: reduce)').matches;

    // ---------- d3-zoom ----------
    const zoomBehavior: ZoomBehavior<SVGSVGElement, unknown> = zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.05, 100])
      .filter((event: Event) => {
        // Mouse button > 0 (right/middle) — block.
        const ev = event as MouseEvent;
        if (typeof ev.button === 'number' && ev.button > 0) return false;
        // Don't pan when starting from a pin (drag owns it).
        const target = ev.target as Element | null;
        if (target && target.closest('[data-pin-id]')) return false;
        // Don't pan/zoom while a cross-component dnd drag is in flight.
        if (isDndDragActiveRef.current) return false;
        return true;
      })
      .on('zoom', (evt) => {
        const t = evt.transform;
        pinLayer.attr('transform', t.toString());
        // Era layer translates at PARALLAX_RATIO * t.x, same scale.
        // Reduced-motion users get a 1:1 transform (no parallax differential).
        const eraTransform = prefersReducedMotion
          ? t.toString()
          : `translate(${t.x * PARALLAX_RATIO}, 0) scale(${t.k})`;
        eraLayer.attr('transform', eraTransform);
        // Surface the live transform to the orchestrator (Plan 06) for
        // inverse-coord math on @dnd-kit drop events. Imperative-only —
        // parent writes to a ref, never setState per tick.
        onTransformChangeRef.current?.({ x: t.x, y: t.y, k: t.k });
        transformRef.current = { x: t.x, y: t.y, k: t.k };
      });
    zoomBehaviorRef.current = zoomBehavior;
    svg.call(zoomBehavior);

    // ---------- d3-drag on pin circles ----------
    let activeKeydownHandler: ((e: KeyboardEvent) => void) | null = null;
    const installKeydown = (handler: (e: KeyboardEvent) => void) => {
      activeKeydownHandler = handler;
      globalThis.addEventListener('keydown', handler);
    };
    const removeKeydown = () => {
      if (activeKeydownHandler) {
        globalThis.removeEventListener('keydown', activeKeydownHandler);
        activeKeydownHandler = null;
      }
    };

    const dragBehavior = drag<SVGCircleElement, RenderedPin>()
      .on('start', (_evt, d) => {
        cancelledRef.current = false;
        onDragSourceChangeRef.current?.(d.pin.id);
        installKeydown((e: KeyboardEvent) => {
          if (e.key !== 'Escape') return;
          cancelledRef.current = true;
          removeKeydown();
          onDragSourceChangeRef.current?.(null);
        });
      })
      .on('drag', function (evt) {
        // Imperative preview — write to the element's cx without React state.
        select(this).attr('cx', evt.x);
      })
      .on('end', (evt, d) => {
        if (cancelledRef.current) {
          // Esc already cleaned up the keydown listener and notified parent.
          return;
        }
        removeKeydown();
        const newPosition = xToPos(
          evt.x,
          timelineWindow.start,
          timelineWindow.end,
          width,
        );
        onPinDragEndRef.current?.(d.pin, newPosition);
        onDragSourceChangeRef.current?.(null);
      });
    pinSel.call(dragBehavior);

    // ---------- click dispatch ----------
    pinSel.on('click', (evt: MouseEvent, d) => {
      evt.stopPropagation();
      onPinClickRef.current?.(d.pin);
    });

    // ---------- Esc → home (when no drag in flight) ----------
    const escHomeHandler = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      // If a drag is in flight, the per-drag keydown listener handles it
      // (cancelledRef is true). Skip the home reset to avoid clobbering the
      // mid-drag cancel.
      if (cancelledRef.current || activeKeydownHandler) return;
      // Reset to home view. The d3-transition package is not in the tree
      // (RESEARCH §"Don't Hand-Roll" — keep dependency surface small), so we
      // apply the identity transform immediately. The 300ms animation called
      // out in UI-SPEC §Animation is a deferred polish item; functional
      // home-reset behavior (D-07c) is preserved.
      svg.call(zoomBehavior.transform, zoomIdentity);
    };
    globalThis.addEventListener('keydown', escHomeHandler);

    return () => {
      svg.on('.zoom', null);
      pinSel.on('.drag', null).on('click', null);
      removeKeydown();
      globalThis.removeEventListener('keydown', escHomeHandler);
      zoomBehaviorRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pins, timelineWindow.start, timelineWindow.end, width, height]);

  const onPointerMove = (e: ReactPointerEvent<SVGSVGElement>) => {
    if (!svgRef.current) return;
    const rect = svgRef.current.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    setCursor({ x, y });
    const t = transformRef.current;
    let hovered: string | null = null;
    let bestD = Infinity;
    for (const rp of renderedPins) {
      const sx = t.x + t.k * rp.x;
      const sy = t.y + t.k * rp.cy;
      const d = Math.hypot(x - sx, y - sy);
      if (d < HOVER_RADIUS && d < bestD) {
        bestD = d;
        hovered = rp.pin.id;
      }
    }
    setHoveredPinId(hovered);
  };

  const onPointerLeave = () => {
    setCursor(null);
    setHoveredPinId(null);
  };

  const hoveredRenderedPin =
    hoveredPinId ? renderedPins.find((rp) => rp.pin.id === hoveredPinId) ?? null : null;

  return (
    <div className="relative h-full w-full">
    <svg
      ref={svgRef}
      role="application"
      aria-label="Timeline canvas"
      width={width}
      height={height}
      className="block h-full w-full select-none"
      data-testid="timeline-canvas"
      onPointerMove={onPointerMove}
      onPointerLeave={onPointerLeave}
    >
      <g className="era-layer" data-testid="era-layer">
        {renderedSpans.map(({ span, x, width: w }) => (
          <g key={`era-${span.era.id}`}>
            <rect
              data-era-id={span.era.id}
              x={x}
              y={0}
              width={w}
              height={height}
              fill="var(--color-accent)"
              opacity={0.18}
            />
            <text
              x={x + 4}
              y={14}
              className="text-[color:var(--color-accent)]"
              fontSize={12}
              fontWeight={600}
              fill="currentColor"
              pointerEvents="none"
            >
              {span.era.label}
            </text>
          </g>
        ))}
      </g>
      <g className="pin-layer" data-testid="pin-layer">
        <g className="baseline" data-testid="baseline">
          <line
            x1={0}
            x2={width}
            y1={baselineY}
            y2={baselineY}
            stroke="currentColor"
            strokeWidth={2}
            className="text-neutral-300 dark:text-neutral-700"
          />
        </g>
        <g className="pins">
          {renderedPins.map(({ pin, x, cy, clamped, clampSide }) => {
            const displayName = pin.entryTitle || pin.label || 'Pin';
            const fillColor =
              pin.precision === 'era'
                ? 'var(--color-accent)'
                : pin.entryType
                  ? entryTypeHexColor(pin.entryType)
                  : 'currentColor';
            return (
              <circle
                key={pin.id}
                data-pin-id={pin.id}
                data-position={String(pin.position)}
                data-clamped={clamped ? 'true' : undefined}
                data-clamp-side={clampSide ?? undefined}
                aria-label={
                  clamped
                    ? clampSide === 'before'
                      ? `${displayName} is before the visible range`
                      : `${displayName} is after the visible range`
                    : `${displayName} at position ${pin.position}`
                }
                cx={x}
                cy={cy}
                r={PIN_RADIUS}
                fill={fillColor}
                className={
                  clamped
                    ? 'opacity-40 cursor-pointer'
                    : 'cursor-pointer'
                }
              >
                <title>
                  {pin.label ? `${displayName} — ${pin.label}` : displayName}
                </title>
              </circle>
            );
          })}
        </g>
        <g className="out-of-range" data-testid="out-of-range">
          {renderedPins
            .filter((rp) => rp.clamped)
            .map(({ pin, cy, clampSide }) => (
              <text
                key={`oor-${pin.id}`}
                data-oor-for={pin.id}
                x={clampSide === 'before' ? 8 : width - 8}
                y={cy + 4}
                textAnchor={clampSide === 'before' ? 'start' : 'end'}
                fontSize={16}
                className="text-neutral-400 opacity-40"
                fill="currentColor"
                pointerEvents="none"
                aria-hidden="true"
              >
                {clampSide === 'before' ? '›' : '‹'}
              </text>
            ))}
        </g>
      </g>
    </svg>
      {cursor &&
        renderedPins.map(({ pin, x, cy }) => {
          const t = transformRef.current;
          const sx = t.x + t.k * x;
          const sy = t.y + t.k * cy;
          const d = Math.hypot(cursor.x - sx, cursor.y - sy);
          if (d >= PROXIMITY_THRESHOLD) return null;
          const opacity = Math.max(
            0,
            Math.min(
              1,
              (PROXIMITY_THRESHOLD - d) / (PROXIMITY_THRESHOLD - HOVER_RADIUS),
            ),
          );
          if (opacity < 0.05) return null;
          if (hoveredPinId === pin.id) return null;
          const displayName = pin.entryTitle || pin.label || 'Pin';
          return (
            <div
              key={`label-${pin.id}`}
              className="pointer-events-none absolute select-none whitespace-nowrap rounded bg-neutral-900/85 px-1.5 py-0.5 text-xs font-medium text-neutral-100 shadow"
              style={{
                left: sx,
                top: sy - PIN_RADIUS - 6,
                transform: 'translate(-50%, -100%)',
                opacity,
              }}
            >
              {displayName}
            </div>
          );
        })}
      {hoveredRenderedPin &&
        (() => {
          const t = transformRef.current;
          const sx = t.x + t.k * hoveredRenderedPin.x;
          const sy = t.y + t.k * hoveredRenderedPin.cy;
          const pin = hoveredRenderedPin.pin;
          const displayName = pin.entryTitle || pin.label || 'Untitled pin';
          return (
            <div
              data-testid="timeline-pin-popover"
              className="pointer-events-none absolute z-10"
              style={{
                left: sx,
                top: sy - PIN_RADIUS - 10,
                transform: 'translate(-50%, -100%)',
              }}
            >
              <div className="min-w-[180px] max-w-[260px] rounded-lg border border-neutral-700 bg-neutral-900/95 px-3 py-2 shadow-xl backdrop-blur-sm">
                <div className="text-sm font-semibold text-neutral-50">{displayName}</div>
                <div className="mt-0.5 text-xs text-neutral-400">
                  {formatCalendar(pin.position, calendar)?.compact ?? POSITION_FORMAT.format(pin.position)}
                  <span className="mx-1 text-neutral-600">·</span>
                  {pin.precision}
                </div>
                {pin.label && pin.label !== pin.entryTitle && (
                  <div className="mt-1 truncate text-xs italic text-neutral-300">
                    “{pin.label}”
                  </div>
                )}
                <div className="mt-1 text-[10px] uppercase tracking-wide text-neutral-500">
                  Click to open
                </div>
              </div>
            </div>
          );
        })()}
    </div>
  );
}
