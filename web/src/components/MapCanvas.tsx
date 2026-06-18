import { useEffect, useRef, useState } from 'react';
import { select } from 'd3-selection';
import { zoom, zoomTransform, type ZoomBehavior } from 'd3-zoom';
import { useNavigate } from 'react-router-dom';
import { entryTypeHexColor } from '../lib/entryTypeColor';
import type { MapPin } from '../hooks/useMap';

// ─── Constants ────────────────────────────────────────────────────────────────
const NODE_RADIUS = 14;        // matches DiagramCanvas NODE_RADIUS
const HIT_RADIUS = 22;         // transparent hit area — 44px diameter touch target
const SELECTION_RING_R = 18;   // HALO_RADIUS in DiagramCanvas terms
const DRAG_THRESHOLD_PX = 4;   // pointer movement below this is treated as a click

/** Clamp a number to [lo, hi]. */
function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

// ─── Props ────────────────────────────────────────────────────────────────────
export interface MapCanvasProps {
  /** Pre-signed full-res URL for the map image. */
  imageUrl: string;
  /** Image natural width in pixels (used for fit-to-view and coord conversion). */
  imageWidth: number;
  /** Image natural height in pixels. */
  imageHeight: number;
  /** Pins with optional joined entryTitle/entryType. */
  pins: MapPin[];
  /** When true, cursor shows crosshair and canvas click emits onCanvasClick. */
  addPinMode: boolean;
  /** Currently selected pin id (shows selection ring). Null clears selection. */
  selectedPinId: string | null;
  /** Universe id for same-tab entry navigation. */
  universeId: string;
  /** Called with normalized [0,1] coords when user clicks canvas in addPinMode. */
  onCanvasClick: (nx: number, ny: number) => void;
  /** Called when a pin drag ends with the new normalized position. */
  onPinDragEnd: (pinId: string, nx: number, ny: number) => void;
  /** Called on pin right-click/contextmenu with client coords. */
  onPinContextMenu: (pin: MapPin, clientX: number, clientY: number) => void;
}

// ─── PinCircle ────────────────────────────────────────────────────────────────
/**
 * React-rendered SVG pin group.
 *
 * CRITICAL: All interaction uses React event handlers (onClick, onPointerDown,
 * onPointerMove, onPointerUp, onContextMenu). d3 `.on()` datum handlers are
 * NEVER attached to this component — `d` is undefined on React-rendered elements
 * and would throw (memory: timeline-pins-react-rendered-no-d3-datum).
 *
 * Constant screen size: `scale(1/currentScale)` counteracts the viewport transform.
 *
 * Drag coordinate conversion uses the DELTA approach (zoom-aware):
 *   delta_img_x = (clientX - startClientX) / currentScale
 * This correctly converts zoomed pixels to image pixels without requiring
 * a second reference to the SVG element.
 */
interface PinCircleProps {
  pin: MapPin;
  imageWidth: number;
  imageHeight: number;
  currentScale: number;
  selected: boolean;
  universeId: string;
  onNavigate: (entryId: string) => void;
  onDragEnd: (pinId: string, nx: number, ny: number) => void;
  onContextMenu: (pin: MapPin, clientX: number, clientY: number) => void;
}

function PinCircle({
  pin,
  imageWidth,
  imageHeight,
  currentScale,
  selected,
  onNavigate,
  onDragEnd,
  onContextMenu,
}: PinCircleProps) {
  const pinX = pin.x * imageWidth;
  const pinY = pin.y * imageHeight;

  // Drag state (mutable via ref — no rerender during drag)
  const dragging = useRef(false);
  const dragStart = useRef<{
    clientX: number;
    clientY: number;
    origX: number;
    origY: number;
    moved: boolean;
  } | null>(null);

  const handlePointerDown = (e: React.PointerEvent<SVGGElement>) => {
    e.stopPropagation();
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    dragging.current = true;
    dragStart.current = {
      clientX: e.clientX,
      clientY: e.clientY,
      origX: pin.x,
      origY: pin.y,
      moved: false,
    };
  };

  const handlePointerMove = (e: React.PointerEvent<SVGGElement>) => {
    if (!dragging.current || !dragStart.current) return;
    const dx = Math.abs(e.clientX - dragStart.current.clientX);
    const dy = Math.abs(e.clientY - dragStart.current.clientY);
    if (dx > DRAG_THRESHOLD_PX || dy > DRAG_THRESHOLD_PX) {
      dragStart.current.moved = true;
    }
  };

  const handlePointerUp = (e: React.PointerEvent<SVGGElement>) => {
    if (!dragging.current || !dragStart.current) return;
    (e.currentTarget as Element).releasePointerCapture(e.pointerId);
    dragging.current = false;

    const start = dragStart.current;
    dragStart.current = null;

    if (!start.moved) {
      // Treat as a click — navigate to entry
      onNavigate(pin.entryId);
      return;
    }

    // DRAG-END COORDINATE CONVERSION (zoom-aware, DELTA approach):
    // A screen-space delta is in ZOOMED pixels, so divide by the current zoom
    // scale k before converting to image-space delta. currentScale = k.
    const k = currentScale;
    const dxImg = (e.clientX - start.clientX) / k;
    const dyImg = (e.clientY - start.clientY) / k;
    const nx = clamp(start.origX + dxImg / imageWidth, 0, 1);
    const ny = clamp(start.origY + dyImg / imageHeight, 0, 1);
    onDragEnd(pin.id, nx, ny);
  };

  const handleContextMenu = (e: React.MouseEvent<SVGGElement>) => {
    e.preventDefault();
    e.stopPropagation();
    onContextMenu(pin, e.clientX, e.clientY);
  };

  return (
    <g
      transform={`translate(${pinX},${pinY}) scale(${1 / currentScale})`}
      style={{ cursor: 'pointer' }}
      aria-label={pin.entryTitle ?? 'Pin'}
      role="button"
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onContextMenu={handleContextMenu}
    >
      {/* SVG tooltip for hover — D-09 */}
      <title>{pin.entryTitle ?? 'Pin'}</title>

      {/* Transparent hit area — 44px touch target (HIT_RADIUS=22 -> 44px diameter) */}
      <circle r={HIT_RADIUS} fill="transparent" />

      {/* Visible pin circle — identical to DiagramCanvas node style */}
      <circle
        r={NODE_RADIUS}
        fill={entryTypeHexColor(pin.entryType ?? 'concept')}
        stroke="#111827"
        strokeWidth={1}
      />

      {/* Selection ring — shown when pin is selected (delete/relink context) */}
      {selected && (
        <circle
          r={SELECTION_RING_R}
          fill="none"
          stroke="var(--color-accent)"
          strokeWidth={2}
        />
      )}
    </g>
  );
}

// ─── MapCanvas ────────────────────────────────────────────────────────────────
/**
 * SVG canvas with d3-zoom/pan applied to the `<svg>` element only.
 * Pins are React-rendered inside `<g class="pins">` and use React event
 * handlers exclusively — no d3 datum binding on pin elements.
 *
 * d3 APIs used:
 *   - d3.zoom() on the <svg> element
 *   - d3.select() for the <g.viewport> element
 *   - zoomBehavior.translateTo / scaleTo for initial fit-to-view
 *   - d3.zoomTransform(svgEl) to read current transform for coord inversion
 *
 * COORDINATE CONVERSION (Approach A — two-step):
 *   Step 1: screen → SVG-ROOT space via svgEl.getScreenCTM().inverse()
 *   Step 2: SVG-ROOT → IMAGE space via d3.zoomTransform(svgEl).invert()
 * This correctly accounts for the d3 zoom transform on <g.viewport>.
 * Using getScreenCTM().inverse() alone (on the svg root) would give SVG-ROOT
 * coords, NOT image coords — pins would persist at the wrong location after
 * any pan or zoom (this is the MAPS-03 correctness bug).
 */
export function MapCanvas({
  imageUrl,
  imageWidth,
  imageHeight,
  pins,
  addPinMode,
  selectedPinId,
  universeId,
  onCanvasClick,
  onPinDragEnd,
  onPinContextMenu,
}: MapCanvasProps) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [currentScale, setCurrentScale] = useState(1);
  const navigate = useNavigate();

  // Install d3-zoom on the svg element, targeting <g.viewport>.
  // Pins are React-rendered inside this effect's SVG structure but are
  // NOT touched by d3 — d3 only manages the zoom transform on <g.viewport>.
  useEffect(() => {
    if (!svgRef.current || imageWidth <= 0 || imageHeight <= 0) return;

    const svgEl = svgRef.current;
    const svg = select(svgEl);
    const g = svg.select<SVGGElement>('g.viewport');

    const zoomBehavior: ZoomBehavior<SVGSVGElement, unknown> = zoom<
      SVGSVGElement,
      unknown
    >()
      .scaleExtent([0.1, 8])
      .on('zoom', (evt) => {
        g.attr('transform', evt.transform.toString());
        setCurrentScale(evt.transform.k);
      });

    svg.call(zoomBehavior);
    // Disable d3's built-in dblclick-to-zoom so a double-click on a pin
    // doesn't accidentally zoom the canvas.
    svg.on('dblclick.zoom', null);

    // Fit image to viewport on mount.
    // Scale so the image fills the viewport without clipping.
    const vw = svgEl.clientWidth || svgEl.getBoundingClientRect().width;
    const vh = svgEl.clientHeight || svgEl.getBoundingClientRect().height;
    if (vw > 0 && vh > 0) {
      const scale = Math.min(vw / imageWidth, vh / imageHeight);
      zoomBehavior.translateTo(svg, imageWidth / 2, imageHeight / 2);
      zoomBehavior.scaleTo(svg, scale);
    }

    return () => {
      svg.on('.zoom', null);
    };
  }, [imageWidth, imageHeight]);

  // CANVAS CLICK — COORDINATE CONVERSION (Approach A — two-step).
  // Only fires when addPinMode is active.
  const handleSvgClick = (e: React.MouseEvent<SVGSVGElement>) => {
    if (!addPinMode) return;
    // Ignore clicks that originated on a pin group (they handle their own events).
    if ((e.target as Element).closest('g[aria-label]')) return;

    const svgEl = svgRef.current;
    if (!svgEl) return;

    const pt = svgEl.createSVGPoint();
    pt.x = e.clientX;
    pt.y = e.clientY;

    // Step 1: screen → SVG-ROOT space (NOT yet image space).
    const screenCTM = svgEl.getScreenCTM();
    if (!screenCTM) return;
    const root = pt.matrixTransform(screenCTM.inverse());

    // Step 2: undo the d3 zoom transform (which lives on <g.viewport>) → IMAGE space.
    // zoomTransform reads the transform stored on the svg element by d3.
    const [imgX, imgY] = zoomTransform(svgEl).invert([root.x, root.y]);

    const nx = clamp(imgX / imageWidth, 0, 1);
    const ny = clamp(imgY / imageHeight, 0, 1);
    onCanvasClick(nx, ny);
  };

  const handleNavigate = (entryId: string) => {
    navigate(`/universes/${universeId}/entries/${entryId}`);
  };

  return (
    <svg
      ref={svgRef}
      role="application"
      aria-label="Map canvas"
      className={[
        'block h-full w-full select-none',
        addPinMode ? 'cursor-crosshair' : '',
      ]
        .filter(Boolean)
        .join(' ')}
      onClick={handleSvgClick}
    >
      <g className="viewport">
        {/* Map background image layer */}
        <image
          href={imageUrl}
          x="0"
          y="0"
          width={imageWidth}
          height={imageHeight}
          preserveAspectRatio="xMidYMid meet"
        />

        {/* React-rendered pins — NO d3 datum binding here */}
        <g className="pins">
          {pins.map((pin) => (
            <PinCircle
              key={pin.id}
              pin={pin}
              imageWidth={imageWidth}
              imageHeight={imageHeight}
              currentScale={currentScale}
              selected={selectedPinId === pin.id}
              universeId={universeId}
              onNavigate={handleNavigate}
              onDragEnd={onPinDragEnd}
              onContextMenu={onPinContextMenu}
            />
          ))}
        </g>
      </g>
    </svg>
  );
}
