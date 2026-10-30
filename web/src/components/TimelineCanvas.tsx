import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { drag } from 'd3-drag';
import { select } from 'd3-selection';
import { zoom, zoomIdentity, type ZoomBehavior } from 'd3-zoom';
import {
  clampXToCanvas,
  posToX,
  xToPos,
  clampedPosToX,
} from '../lib/timelineMath';
import { inferEraSpans, type EraSpan } from '../lib/groupByEra';
import type { TimelinePin } from '../hooks/useTimelinePins';
import { formatCalendar, type Calendar } from '../lib/calendarFormat';
import { MedallionSVGNode } from './MedallionSVG';
import type { MedallionSource } from '../lib/medallion';

const PARALLAX_RATIO = 0.5;

const PIN_RADIUS = 9;

const STACK_OFFSET = 40;

const HOVER_RADIUS = 14;
const PROXIMITY_THRESHOLD = 110;

const POSITION_FORMAT = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 });
const COMPACT_POSITION_FORMAT = new Intl.NumberFormat('en-US', {
  notation: 'compact',
  maximumFractionDigits: 2,
});

function formatAxisPosition(position: number, calendar: Calendar | null): string {
  const calendarDate = formatCalendar(position, calendar);
  if (calendarDate) return calendarDate.compact;
  return Math.abs(position) >= 1_000_000
    ? COMPACT_POSITION_FORMAT.format(position)
    : POSITION_FORMAT.format(position);
}

function niceAxisStep(span: number, targetTickCount: number): number {
  const rough = Math.abs(span) / Math.max(1, targetTickCount);
  if (!Number.isFinite(rough) || rough === 0) return 1;
  const power = 10 ** Math.floor(Math.log10(rough));
  const fraction = rough / power;
  const niceFraction = fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 5 ? 5 : 10;
  return niceFraction * power;
}

function axisValues(start: number, end: number, width: number): number[] {
  const step = niceAxisStep(end - start, Math.max(2, Math.floor(width / 140)));
  const first = Math.ceil(start / step) * step;
  const values: number[] = [];
  for (let value = first; value <= end && values.length < 100; value += step) {
    values.push(Number(value.toPrecision(12)));
  }
  return values;
}

function axisTextAnchor(x: number, width: number): 'start' | 'middle' | 'end' {
  if (x < 48) return 'start';
  if (x > width - 48) return 'end';
  return 'middle';
}

export interface TimelineCanvasProps {
  universeId: string;
  pins: TimelinePin[];
  window: { start: number; end: number };
  width: number;
  height: number;
  calendar: Calendar | null;
  medallions?: Map<string, MedallionSource>;
  onPinClick?: (pin: TimelinePin) => void;
  pinsDraggable?: boolean;
  onPinDragEnd?: (pin: TimelinePin, newPosition: number) => void;
  onDragSourceChange?: (pinId: string | null) => void;
  isDndDragActive?: boolean;
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

export function TimelineCanvas({
  universeId: _universeId,
  pins,
  window: timelineWindow,
  width,
  height,
  calendar,
  medallions,
  onPinClick,
  pinsDraggable = true,
  onPinDragEnd,
  onDragSourceChange,
  isDndDragActive,
  onTransformChange,
}: TimelineCanvasProps) {
  const svgRef = useRef<SVGSVGElement>(null);

  // parent re-renders that hand new arrow-function identities.
  const onPinClickRef = useRef(onPinClick);
  const onPinDragEndRef = useRef(onPinDragEnd);
  const onDragSourceChangeRef = useRef(onDragSourceChange);
  const onTransformChangeRef = useRef(onTransformChange);
  // re-binding (share-mode is constant per mount, but a ref keeps the stable
  const pinsDraggableRef = useRef(pinsDraggable);
  useEffect(() => {
    onPinClickRef.current = onPinClick;
    onPinDragEndRef.current = onPinDragEnd;
    onDragSourceChangeRef.current = onDragSourceChange;
    onTransformChangeRef.current = onTransformChange;
    pinsDraggableRef.current = pinsDraggable;
  });

  // Esc-cancel mid-drag (D-08a): set by the keydown listener installed at
  // drag start, read by the d3-drag `end` handler to skip the onPinDragEnd
  const cancelledRef = useRef(false);
  // Mirrors isDndDragActive so the d3-zoom filter (which is captured at setup
  // time) sees the live value without re-binding the zoom behavior.
  const isDndDragActiveRef = useRef(!!isDndDragActive);
  useEffect(() => {
    isDndDragActiveRef.current = !!isDndDragActive;
  }, [isDndDragActive]);

  // Latest d3-zoom transform — exposed for orchestrator-side coordinate
  const zoomBehaviorRef = useRef<ZoomBehavior<SVGSVGElement, unknown> | null>(null);
  // Local mirror of the d3-zoom transform — used for cursor-to-pin proximity
  // React re-renders (RESEARCH §Pitfall 1).
  const transformRef = useRef({ x: 0, y: 0, k: 1 });

  // Cursor in SVG-container screen coords + currently-hovered pin id, both for
  const [cursor, setCursor] = useState<{ x: number; y: number } | null>(null);
  const [hoveredPinId, setHoveredPinId] = useState<string | null>(null);

  // Pre-compute the render data outside the d3 effect so the JSX can also
  const baselineY = height / 2;
  const initialAxisTicks = useMemo(() => {
    return axisValues(timelineWindow.start, timelineWindow.end, width).map((value) => {
      return {
        value,
        x: posToX(value, timelineWindow.start, timelineWindow.end, width),
        label: formatAxisPosition(value, calendar),
      };
    });
  }, [calendar, timelineWindow.end, timelineWindow.start, width]);

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
  const spans = inferEraSpans(pins, timelineWindow.end).filter(
    (s) => s.endPos > s.startPos, // drop zero-width spans (back-to-back eras)
  );
  const renderedSpans: RenderedSpan[] = spans.map((s) => {
    const xStart = posToX(s.startPos, timelineWindow.start, timelineWindow.end, width);
    const xEnd = posToX(s.endPos, timelineWindow.start, timelineWindow.end, width);
    return { span: s, x: xStart, width: Math.max(0, xEnd - xStart) };
  });

  // Spec §6 — a label per pin only when there's room. A rough per-character width estimate is
  // enough: being wrong costs a slightly-clipped label, not a broken axis. Crowded pins keep
  const labelVisibleFor = useMemo(() => {
    const visible = new Set<string>();
    const sorted = [...renderedPins].sort((a, b) => a.x - b.x);
    for (let i = 0; i < sorted.length; i++) {
      const cur = sorted[i]!;
      const next = sorted[i + 1];
      const name = cur.pin.entryTitle || cur.pin.label || 'Pin';
      const needed = PIN_RADIUS + 5 + name.length * 6;
      if (!next || next.x - cur.x > needed) visible.add(cur.pin.id);
    }
    return visible;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [renderedPins]);

  // d3-zoom + d3-drag wiring. Runs once per [pins, window, width, height]
  useEffect(() => {
    if (!svgRef.current) return;
    const svg = select(svgRef.current);
    const eraLayer = svg.select<SVGGElement>('g.era-layer');
    const axisLayer = svg.select<SVGGElement>('g.axis-layer');
    const pinLayer = svg.select<SVGGElement>('g.pin-layer');
    // Content-Forward Views §6: the pins are medallion <g> groups now, not bare <circle>s.
    // This selection feeds the d3-DRAG behavior only — the click-to-open path stays React
    const pinSel = pinLayer
      .select<SVGGElement>('g.pins')
      .selectAll<SVGGElement, RenderedPin>('g[data-pin-id]');

    const prefersReducedMotion =
      typeof globalThis.matchMedia === 'function' &&
      globalThis.matchMedia('(prefers-reduced-motion: reduce)').matches;

    const updateAxis = (transform: { x: number; k: number }) => {
      const configuredSpan = timelineWindow.end - timelineWindow.start;
      const positionAtCanvasX = (canvasX: number) =>
        timelineWindow.start + (canvasX / width) * configuredSpan;
      const visibleStart = positionAtCanvasX(-transform.x / transform.k);
      const visibleEnd = positionAtCanvasX(
        (width - transform.x) / transform.k,
      );
      const ticks = axisValues(visibleStart, visibleEnd, width).map((value) => ({
        value,
        x:
          transform.x +
          transform.k *
            posToX(value, timelineWindow.start, timelineWindow.end, width),
      }));

      const tickGroups = axisLayer
        .selectAll<SVGGElement, (typeof ticks)[number]>('g[data-axis-tick]')
        .data(ticks)
        .join((enter) => {
          const group = enter.append('g');
          group
            .append('line')
            .attr('stroke', 'currentColor')
            .attr('class', 'text-neutral-400 dark:text-neutral-500');
          group
            .append('text')
            .attr('font-size', 10)
            .attr('fill', 'currentColor')
            .attr('class', 'text-neutral-600 dark:text-neutral-300');
          return group;
        })
        .attr('data-axis-tick', (datum) => String(datum.value));

      tickGroups
        .select('line')
        .attr('x1', (datum) => datum.x)
        .attr('x2', (datum) => datum.x)
        .attr('y1', baselineY - 5)
        .attr('y2', baselineY + 5);
      tickGroups
        .select('text')
        .attr('x', (datum) => datum.x)
        .attr('y', baselineY + 19)
        .attr('text-anchor', (datum) => axisTextAnchor(datum.x, width))
        .text((datum) => formatAxisPosition(datum.value, calendar));

      axisLayer
        .select<SVGTextElement>('[data-testid="timeline-visible-range"]')
        .text(
          `${formatAxisPosition(visibleStart, calendar)} – ${formatAxisPosition(visibleEnd, calendar)}`,
        );
    };

    // ---------- d3-zoom ----------
    const zoomBehavior: ZoomBehavior<SVGSVGElement, unknown> = zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.05, 100])
      .filter((event: Event) => {
        const ev = event as MouseEvent;
        if (typeof ev.button === 'number' && ev.button > 0) return false;
        const target = ev.target as Element | null;
        if (target && target.closest('[data-pin-id]')) return false;
        // Don't pan/zoom while a cross-component dnd drag is in flight.
        if (isDndDragActiveRef.current) return false;
        return true;
      })
      .on('zoom', (evt) => {
        const t = evt.transform;
        pinLayer.attr('transform', t.toString());
        // Reduced-motion users get a 1:1 transform (no parallax differential).
        const eraTransform = prefersReducedMotion
          ? t.toString()
          : `translate(${t.x * PARALLAX_RATIO}, 0) scale(${t.k})`;
        eraLayer.attr('transform', eraTransform);
        updateAxis(t);
        // inverse-coord math on @dnd-kit drop events. Imperative-only —
        onTransformChangeRef.current?.({ x: t.x, y: t.y, k: t.k });
        transformRef.current = { x: t.x, y: t.y, k: t.k };
      });
    zoomBehaviorRef.current = zoomBehavior;
    svg.call(zoomBehavior);
    updateAxis(transformRef.current);

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

    const dragBehavior = drag<SVGGElement, RenderedPin>()
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
        // Imperative preview — rewrite the medallion group's translate-x without React
        // state. The y is the stacked-baseline offset React already wrote into the
        // transform; re-read it rather than re-deriving it here.
        const el = select(this);
        const cy = /translate\(\s*[-\d.]+\s*,\s*([-\d.]+)/.exec(el.attr('transform') ?? '')?.[1];
        const clampedX = clampXToCanvas(evt.x, width);
        el.attr('transform', `translate(${clampedX}, ${cy ?? 0})`);
      })
      .on('end', (evt, d) => {
        if (cancelledRef.current) {
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
    // behavior — read-only pins must not be repositionable.
    if (pinsDraggableRef.current) {
      pinSel.call(dragBehavior);
    }

    // ---------- click dispatch ----------
    // Pin click-to-open is handled by a React onClick on the <g> JSX, NOT
    // here. The pins are React-rendered, so this d3 selection carries NO datum

    // ---------- Esc → home (when no drag in flight) ----------
    const escHomeHandler = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      // If a drag is in flight, the per-drag keydown listener handles it
      // mid-drag cancel.
      if (cancelledRef.current || activeKeydownHandler) return;
      // Reset to home view. The d3-transition package is not in the tree
      // (RESEARCH §"Don't Hand-Roll" — keep dependency surface small), so we
      // out in UI-SPEC §Animation is a deferred polish item; functional
      // home-reset behavior (D-07c) is preserved.
      svg.call(zoomBehavior.transform, zoomIdentity);
    };
    globalThis.addEventListener('keydown', escHomeHandler);

    return () => {
      svg.on('.zoom', null);
      pinSel.on('.drag', null);
      removeKeydown();
      globalThis.removeEventListener('keydown', escHomeHandler);
      zoomBehaviorRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pins, timelineWindow.start, timelineWindow.end, width, height, calendar]);

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
      <g className="axis-layer" data-testid="timeline-axis">
        {initialAxisTicks.map((tick) => (
          <g key={tick.value} data-axis-tick={String(tick.value)}>
            <line
              x1={tick.x}
              x2={tick.x}
              y1={baselineY - 5}
              y2={baselineY + 5}
              stroke="currentColor"
              className="text-neutral-400 dark:text-neutral-500"
            />
            <text
              x={tick.x}
              y={baselineY + 19}
              textAnchor={axisTextAnchor(tick.x, width)}
              fontSize={10}
              fill="currentColor"
              className="text-neutral-600 dark:text-neutral-300"
            >
              {tick.label}
            </text>
          </g>
        ))}
        <text
          data-testid="timeline-visible-range"
          x={width - 8}
          y={16}
          textAnchor="end"
          fontSize={11}
          fontWeight={600}
          fill="currentColor"
          className="text-neutral-600 dark:text-neutral-300"
        >
          {formatAxisPosition(timelineWindow.start, calendar)} –{' '}
          {formatAxisPosition(timelineWindow.end, calendar)}
        </text>
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
            const source: MedallionSource =
              medallions?.get(pin.entryId) ?? {
                title: displayName,
                entryType: pin.entryType ?? 'concept',
                icon: pin.entryIcon ?? null,
                coverThumbUrl: null,
              };
            return (
              <g
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
                transform={`translate(${x}, ${cy})`}
                // The pins are React-rendered, so the imperative d3 selection
                // (undefined) while stopPropagation-ing the real click. This
                onClick={() => onPinClick?.(pin)}
                className={
                  clamped
                    ? 'opacity-40 cursor-pointer'
                    : 'cursor-pointer'
                }
              >
                <title>
                  {pin.label ? `${displayName} — ${pin.label}` : displayName}
                </title>
                {/* Era-precision pins carry an accent outer ring. The medallion owns the
                    disc's own fill/stroke (entry-type hue), so precision rides OUTSIDE it —
                    otherwise the only signal that a date is an approximate era would be
                    hover-only. Dashed reads as "approximate" and cannot be confused with the
                    medallion's own solid type-hued stroke. Painted first, so it sits behind
                    the disc it surrounds and cannot cover it. */}
                {pin.precision === 'era' && (
                  <circle
                    className="pin-era-ring"
                    r={PIN_RADIUS + 3}
                    fill="none"
                    stroke="var(--color-accent)"
                    strokeWidth={1.5}
                    strokeDasharray="3 2"
                    pointerEvents="none"
                  />
                )}
                {/* The clipPath id is surface-prefixed: SVG url(#…) resolves to the FIRST
                    match in the document, so an unprefixed `${pin.id}` could clip against
                    the graph's circle of the same name (wrong radius, silently). */}
                <MedallionSVGNode
                  id={`timeline-${pin.id}`}
                  radius={PIN_RADIUS}
                  {...source}
                />
                {!clamped && labelVisibleFor.has(pin.id) && (
                  <text
                    className="timeline-pin-label"
                    x={PIN_RADIUS + 5}
                    y={0}
                    dominantBaseline="central"
                    fontSize={10}
                    fontFamily="var(--font-sans)"
                    fill="var(--color-ink-secondary)"
                    pointerEvents="none"
                  >
                    {displayName}
                  </text>
                )}
              </g>
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
              <div className="min-w-[180px] max-w-[260px] rounded-lg border border-line-strong bg-raised px-3 py-2 shadow-xl">
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
