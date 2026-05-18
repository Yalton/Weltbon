import { useEffect, useRef } from 'react';
import { drag } from 'd3-drag';
import { select } from 'd3-selection';
import { zoom, zoomIdentity, type ZoomBehavior } from 'd3-zoom';
import { posToX, xToPos, clampedPosToX } from '../lib/timelineMath';
import { inferEraSpans, type EraSpan } from '../lib/groupByEra';
import type { TimelinePin } from '../hooks/useTimelinePins';

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

export interface TimelineCanvasProps {
  universeId: string;
  pins: TimelinePin[];
  window: { start: number; end: number };
  width: number;
  height: number;
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
  onPinClick,
  onPinDragEnd,
  onDragSourceChange,
  isDndDragActive,
}: TimelineCanvasProps) {
  const svgRef = useRef<SVGSVGElement>(null);

  // Mirrored callback refs so the main effect's dep list stays stable across
  // parent re-renders that hand new arrow-function identities.
  const onPinClickRef = useRef(onPinClick);
  const onPinDragEndRef = useRef(onPinDragEnd);
  const onDragSourceChangeRef = useRef(onDragSourceChange);
  useEffect(() => {
    onPinClickRef.current = onPinClick;
    onPinDragEndRef.current = onPinDragEnd;
    onDragSourceChangeRef.current = onDragSourceChange;
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

  return (
    <svg
      ref={svgRef}
      role="application"
      aria-label="Timeline canvas"
      width={width}
      height={height}
      className="block h-full w-full select-none"
      data-testid="timeline-canvas"
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
          {renderedPins.map(({ pin, x, cy, clamped, clampSide }) => (
            <circle
              key={pin.id}
              data-pin-id={pin.id}
              data-position={String(pin.position)}
              data-clamped={clamped ? 'true' : undefined}
              data-clamp-side={clampSide ?? undefined}
              aria-label={
                clamped
                  ? clampSide === 'before'
                    ? `${pin.label} is before the visible range`
                    : `${pin.label} is after the visible range`
                  : `${pin.label} at position ${pin.position}`
              }
              cx={x}
              cy={cy}
              r={PIN_RADIUS}
              fill={pin.precision === 'era' ? 'var(--color-accent)' : 'currentColor'}
              className={
                clamped
                  ? 'opacity-40 cursor-pointer text-neutral-400'
                  : 'cursor-pointer text-neutral-700 dark:text-neutral-300'
              }
            />
          ))}
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
  );
}
