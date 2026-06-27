import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { select } from 'd3-selection';
import { zoom, zoomTransform, type ZoomBehavior } from 'd3-zoom';
import { useNavigate } from 'react-router-dom';
import { entryTypeHexColor } from '../lib/entryTypeColor';
import { GlyphIcon } from '../lib/mapGlyphs';
import type { MapPin, MapRegion, TerrainAreaRegion, MapRoute } from '../hooks/useMap';
import type { MapLayer } from '../hooks/useMapLayers';
import { useShareToken } from '../contexts/ShareModeContext';

// ─── Constants ────────────────────────────────────────────────────────────────
const HIT_RADIUS = 22;         // transparent hit area — 44px diameter touch target
const DRAG_THRESHOLD_PX = 4;   // pointer movement below this is treated as a click
const SNAP_DISTANCE_PX = 18;   // first-vertex snap radius in IMAGE pixels (scaled)
const GRID_PX = 100;           // grid spacing in image pixels (T-50-03: bounded by imageWidth/GRID_PX)
const ROUTE_HIT_WIDTH = 20;    // wide transparent hit-stroke for route polylines (image-space units)
const ROUTE_LABEL_MAX_CHARS = 24; // label truncation length for route midpoint chip

// ─── Teardrop pin marker geometry (D-03) ─────────────────────────────────────
// Tip at local (0,0) = the pin's normalized image coordinate.
// Circular body extends upward (negative y in local coords) so the <g> transform
// `translate(pinX,pinY)` correctly anchors the tip to the pin location.
// Counteracted by scale(1/currentScale) so the marker stays constant screen size.
//
//   Head circle center: (0, -20)  head radius: 11
//   Path: tip → left bezier → head-left (-11,-20) → arc over top → head-right (11,-20)
//         → right bezier → tip
//   Arc: large-arc=1, sweep=0 → counterclockwise in SVG (goes through topmost point (0,-31))
const TEARDROP_D =
  'M 0 0 C -5 -6,-11 -14,-11 -20 A 11 11 0 1 0 11 -20 C 11 -14,5 -6,0 0 Z';

// foreignObject placement for the 16×16 glyph icon, centered at (0, -18) in local coords.
const GLYPH_OFFSET_X = -8;
const GLYPH_OFFSET_Y = -26;

/** Clamp a number to [lo, hi]. */
function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

// ─── Imperative handle (Task 1: D-05 zoom seam) ──────────────────────────────
/**
 * Imperative zoom methods exposed via forwardRef + useImperativeHandle.
 * MapEditor holds a ref to MapCanvas and calls these from MapZoomControls callbacks.
 */
export interface MapCanvasHandle {
  /** Zoom in by 1.3× (scaleBy on the d3 zoomBehavior). */
  zoomIn(): void;
  /** Zoom out by 1/1.3 (scaleBy on the d3 zoomBehavior). */
  zoomOut(): void;
  /** Fit image to viewport — restores the initial fit-to-view transform. */
  fitReset(): void;
}

// ─── Props ────────────────────────────────────────────────────────────────────
export interface MapCanvasProps {
  /** Pre-signed full-res URL for the map image. Null when the backing asset was deleted (ON DELETE SET NULL). */
  imageUrl: string | null;
  /** Image natural width in pixels (used for fit-to-view and coord conversion). */
  imageWidth: number;
  /** Image natural height in pixels. */
  imageHeight: number;
  /** Pins with optional joined entryTitle/entryType/color/icon. */
  pins: MapPin[];
  /** Regions for this map. */
  regions: MapRegion[];
  /** When true, cursor shows crosshair and canvas click emits onCanvasClick. */
  addPinMode: boolean;
  /** When true, canvas click drops a region vertex. */
  drawRegionMode: boolean;
  /** In-progress polygon vertices (normalized 0..1). */
  pendingVertices: Array<{ x: number; y: number }>;
  /** Currently selected pin id (shows selection ring). Null clears selection. */
  selectedPinId: string | null;
  /** Universe id for same-tab entry navigation. */
  universeId: string;
  /** Called with normalized [0,1] coords when user clicks canvas in addPinMode or drawRegionMode. */
  onCanvasClick: (nx: number, ny: number) => void;
  /** Called when a pin drag ends with the new normalized position. */
  onPinDragEnd: (pinId: string, nx: number, ny: number) => void;
  /** Called on pin right-click/contextmenu with client coords. */
  onPinContextMenu: (pin: MapPin, clientX: number, clientY: number) => void;
  /** Called on region left-click (navigate to linked entry). */
  onRegionClick: (region: MapRegion) => void;
  /** Called on region right-click with client coords (context menu). */
  onRegionContextMenu: (region: MapRegion, clientX: number, clientY: number) => void;

  // ── Phase 43: terrain area rendering ────────────────────────────────────────
  /** Terrain areas (MapRegions with non-null terrainTypeId), enriched client-side. */
  terrainAreas?: TerrainAreaRegion[];
  /** Per-viewer layer visibility and opacity (client-only, from MapEditor state). */
  layerViewerState?: Record<string, { visible: boolean; opacity: number }>;
  /** When true, canvas click drops a terrain-area vertex (reuses draw-region pipeline). */
  paintTerrainMode?: boolean;
  /** Called on terrain area right-click with client coords (context menu). */
  onTerrainAreaContextMenu?: (region: TerrainAreaRegion, clientX: number, clientY: number) => void;
  /** Map layers for stacking order (sorted ascending by sortOrder). */
  layers?: MapLayer[];
  /** When true, render the optional faint square grid overlay in image space (D-05). Off by default. */
  gridVisible?: boolean;

  // ── Phase 51 ROUTE-01: route polyline rendering ──────────────────────────────
  /** Routes for this map. */
  routes?: MapRoute[];
  /** Called on route left-click (navigate to linked entry). */
  onRouteClick?: (route: MapRoute) => void;
  /** Called on route right-click with client coords (context menu). */
  onRouteContextMenu?: (route: MapRoute, clientX: number, clientY: number) => void;
  /** When true, canvas click drops a route vertex (reuses draw-region pipeline). */
  drawRouteMode?: boolean;
  /**
   * Called on double-click while drawRouteMode is active — signals the route
   * draw finisher (open polyline closed by dblclick or Enter).
   * d3's dblclick-to-zoom is already suppressed in the d3 zoom setup.
   */
  onCanvasDblClick?: () => void;
  /**
   * Called when the user clicks a pin while drawRouteMode is active.
   * MapEditor appends the pin's exact normalized coords to pendingVertices so the
   * route snaps precisely to the pin rather than using a screen-space approximation.
   * BUG-B fix (51-07). No-op / undefined in share mode.
   */
  onRouteVertexAtPin?: (pin: MapPin) => void;
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
  /** Called on pointer enter with client coords; must NOT call if drag is active (D-11 isolation). */
  onPinHoverEnter: (pin: MapPin, clientX: number, clientY: number) => void;
  /** Called on pointer leave; must NOT call if drag is active (D-11 isolation). */
  onPinHoverLeave: () => void;
  /**
   * When true, a click on this pin calls onRouteVertexAtPin instead of onNavigate,
   * and pin drag-reposition is suppressed (pin is a snap target in route-draw mode).
   * BUG-B fix (51-07).
   */
  drawRouteMode?: boolean;
  /**
   * Called when drawRouteMode is true and the user clicks the pin.
   * MapEditor appends the pin's exact normalized coords to pendingVertices.
   * BUG-B fix (51-07).
   */
  onRouteVertexAtPin?: (pin: MapPin) => void;
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
  onPinHoverEnter,
  onPinHoverLeave,
  drawRouteMode = false,
  onRouteVertexAtPin,
}: PinCircleProps) {
  // Pin color: explicit override or fallback to entry type color (D-01, graceful degradation D-03)
  const pinColor = pin.color ?? entryTypeHexColor(pin.entryType ?? 'concept');
  // Phase 52 SECRET-01: shareToken for lock-badge gate (D-02).
  // Hook called unconditionally at component top — React Hook rules.
  const shareTokenForBadge = useShareToken();

  // ── Drag visual position (D-11 fix) ────────────────────────────────────────
  // Stored in local state so a parent re-render during drag (e.g. selection state
  // change, future tooltip hover) does NOT snap the marker back to pin.x*imageWidth.
  // When null (idle), the transform falls back to pin.x * imageWidth as before.
  const [dragVisualX, setDragVisualX] = useState<number | null>(null);
  const [dragVisualY, setDragVisualY] = useState<number | null>(null);

  // Image-space pin position: use drag-local state during drag to prevent parent
  // re-renders from resetting the visual position mid-drag.
  const pinX = dragVisualX !== null ? dragVisualX : pin.x * imageWidth;
  const pinY = dragVisualY !== null ? dragVisualY : pin.y * imageHeight;

  // Drag bookkeeping (mutable ref — does not trigger re-renders itself)
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
    // In route-draw mode the pin is a snap target, not draggable.
    // Skip drag-tracking so moved stays false and pointer-up treats it as a click → vertex snap.
    // BUG-B fix (51-07).
    if (drawRouteMode) return;
    const dx = e.clientX - dragStart.current.clientX;
    const dy = e.clientY - dragStart.current.clientY;
    if (Math.abs(dx) > DRAG_THRESHOLD_PX || Math.abs(dy) > DRAG_THRESHOLD_PX) {
      dragStart.current.moved = true;
      // Update visual position in local state (D-11 fix: not derived from pin.x during drag)
      const k = currentScale;
      const nx = clamp(dragStart.current.origX + dx / (k * imageWidth), 0, 1);
      const ny = clamp(dragStart.current.origY + dy / (k * imageHeight), 0, 1);
      setDragVisualX(nx * imageWidth);
      setDragVisualY(ny * imageHeight);
    }
  };

  const handlePointerUp = (e: React.PointerEvent<SVGGElement>) => {
    if (!dragging.current || !dragStart.current) return;
    (e.currentTarget as Element).releasePointerCapture(e.pointerId);
    dragging.current = false;

    const start = dragStart.current;
    dragStart.current = null;

    // Clear visual drag state — pin.x * imageWidth resumes after parent re-renders
    setDragVisualX(null);
    setDragVisualY(null);

    if (!start.moved) {
      // Route-draw mode: snap a vertex to this pin's exact location instead of navigating.
      // BUG-B fix (51-07): clicking a pin while drawRouteMode appends a route vertex
      // at the pin's exact normalized coords, not a canvas-click approximation.
      if (drawRouteMode) {
        onRouteVertexAtPin?.(pin);
        return;
      }
      // Idle mode: navigate to entry as before.
      onNavigate(pin.entryId);
      return;
    }

    // DRAG-END COORDINATE CONVERSION (zoom-aware, DELTA approach — VERBATIM D-11):
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

  // Hover handlers — NEVER fire during an active drag (D-11 isolation).
  // Hover state is managed by MapCanvas (not PinCircle) via the callbacks.
  // NEVER attach d3 .on(event,(e,d)=>) for hover — d is undefined on React SVG (memory).
  const handlePointerEnter = (e: React.PointerEvent<SVGGElement>) => {
    // Skip hover during drag to avoid interfering with drag state (D-11 isolation).
    if (dragging.current) return;
    onPinHoverEnter(pin, e.clientX, e.clientY);
  };

  const handlePointerLeave = () => {
    // Skip hover-leave during drag (pointer capture keeps the element "hot" during drag).
    if (dragging.current) return;
    onPinHoverLeave();
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
      onPointerEnter={handlePointerEnter}
      onPointerLeave={handlePointerLeave}
    >
      {/* SVG tooltip for hover */}
      <title>{pin.entryTitle ?? 'Pin'}</title>

      {/* Transparent hit area — 44px touch target (HIT_RADIUS=22 → 44px diameter) */}
      <circle r={HIT_RADIUS} fill="transparent" />

      {/* Selection glow layer — blurred copy behind the marker, only when selected (D-03) */}
      {selected && (
        <path
          d={TEARDROP_D}
          fill={pinColor}
          filter="url(#pin-glow)"
          style={{ pointerEvents: 'none' }}
        />
      )}

      {/* Teardrop marker — drop shadow always applied (D-03) */}
      <path
        d={TEARDROP_D}
        fill={pinColor}
        stroke="rgba(0,0,0,0.35)"
        strokeWidth={1.5}
        filter="url(#pin-shadow)"
      />

      {/* Glyph icon overlay — rendered when pin.icon is set (D-02, T-40-10) */}
      {pin.icon && (
        <foreignObject
          x={GLYPH_OFFSET_X}
          y={GLYPH_OFFSET_Y}
          width={16}
          height={16}
          style={{ pointerEvents: 'none', overflow: 'visible' }}
        >
          <GlyphIcon glyph={pin.icon} size={16} color="#fff" />
        </foreignObject>
      )}

      {/* Phase 52 SECRET-01: lock badge — owner-only, normal style intact (D-02).
          CRITICAL: React SVG only. NEVER attach d3 .on(event,(e,d)=>) here — d is
          undefined on React-rendered nodes and throws (memory: timeline-pins-react-rendered-no-d3-datum).
          Position: top-right of the teardrop circle (10, -30). Badge = dark circle + SVG padlock. */}
      {pin.secret && !shareTokenForBadge && (
        <g transform="translate(10,-30)" style={{ pointerEvents: 'none' }} aria-label="Secret">
          {/* Dark chip */}
          <circle r={7} fill="rgba(15,23,42,0.85)" />
          {/* Padlock shackle (arc) */}
          <path
            d="M-2.5,0.5 L-2.5,-2 A2.5,2.5 0 0,1 2.5,-2 L2.5,0.5"
            stroke="#f1f5f9"
            strokeWidth={1.2}
            fill="none"
            strokeLinecap="round"
          />
          {/* Padlock body */}
          <rect x="-3.5" y="0" width="7" height="5" rx="1" fill="#f1f5f9" />
          {/* Keyhole dot */}
          <circle cx={0} cy={2.5} r={1} fill="rgba(15,23,42,0.85)" />
        </g>
      )}
    </g>
  );
}

// ─── RegionPolygon ────────────────────────────────────────────────────────────
/**
 * React-rendered SVG polygon for a map region (D-07).
 *
 * CRITICAL: All interaction uses React event handlers (onClick, onContextMenu).
 * NEVER use d3 .on(event, (e, d) => ...) on this element — d is undefined on
 * React-rendered SVG and would throw (T-40-09, memory: timeline-pins-react-rendered-no-d3-datum).
 *
 * Translucent fill (fillOpacity 0.18) + solid border (strokeOpacity 1) in the
 * element color (D-07). Renders BEFORE pins in z-order so pins stay on top (D-07).
 *
 * isDrawing gate (43-05): When isDrawing is true (addPinMode||drawRegionMode||paintTerrainMode),
 * the polygon sets pointerEvents:'none' so clicks fall through to the root <svg> onClick
 * (handleSvgClick → onCanvasClick → vertex append). onRegionClick navigation is also
 * suppressed while isDrawing. onContextMenu is UNCHANGED in all modes.
 */
interface RegionPolygonProps {
  region: MapRegion;
  imageWidth: number;
  imageHeight: number;
  isDrawing: boolean;
  onRegionClick: (region: MapRegion) => void;
  onRegionContextMenu: (region: MapRegion, clientX: number, clientY: number) => void;
  /** Called on pointer enter with client coords for the tooltip overlay. */
  onRegionHoverEnter: (region: MapRegion, clientX: number, clientY: number) => void;
  /** Called on pointer leave to clear the tooltip. */
  onRegionHoverLeave: () => void;
}

function RegionPolygon({
  region,
  imageWidth,
  imageHeight,
  isDrawing,
  onRegionClick,
  onRegionContextMenu,
  onRegionHoverEnter,
  onRegionHoverLeave,
}: RegionPolygonProps) {
  // Phase 52 SECRET-01: shareToken for lock-badge gate. Hook called unconditionally (React rules).
  const shareTokenForBadge = useShareToken();

  // Parse the points JSON string to [{x, y}] normalized 0..1 then convert to image space.
  let points: Array<{ x: number; y: number }> = [];
  try {
    points = JSON.parse(region.points) as Array<{ x: number; y: number }>;
  } catch {
    return null;
  }

  if (points.length < 3) return null;

  // Build SVG polygon points string in image-space coords.
  const svgPoints = points
    .map((p) => `${p.x * imageWidth},${p.y * imageHeight}`)
    .join(' ');

  const color = region.color ?? '#6b7280';

  // Centroid (simple average of vertices) for badge placement.
  const centroidX = points.reduce((s, p) => s + p.x * imageWidth, 0) / points.length;
  const centroidY = points.reduce((s, p) => s + p.y * imageHeight, 0) / points.length;

  const handleClick = (e: React.MouseEvent<SVGPolygonElement>) => {
    // While isDrawing: return early WITHOUT stopPropagation and WITHOUT calling onRegionClick.
    // The click bubbles to handleSvgClick → vertex append; no entry navigation occurs (43-05).
    // While idle: stopPropagation + navigate to linked entry (D-07 behavior unchanged).
    if (isDrawing) return;
    e.stopPropagation();
    onRegionClick(region);
  };

  const handleContextMenu = (e: React.MouseEvent<SVGPolygonElement>) => {
    e.preventDefault();
    e.stopPropagation();
    onRegionContextMenu(region, e.clientX, e.clientY);
  };

  // Hover handlers — NEVER attach d3 .on(event,(e,d)=>) — d is undefined on React SVG (memory).
  const handlePointerEnter = (e: React.PointerEvent<SVGPolygonElement>) => {
    onRegionHoverEnter(region, e.clientX, e.clientY);
  };

  const handlePointerLeave = () => {
    onRegionHoverLeave();
  };

  return (
    <g>
      <polygon
        points={svgPoints}
        fill={color}
        fillOpacity={0.18}
        stroke={color}
        strokeWidth={1.5}
        strokeOpacity={1}
        style={{
          cursor: region.entryId ? 'pointer' : 'default',
          pointerEvents: isDrawing ? 'none' : 'auto',
        }}
        onClick={handleClick}
        onContextMenu={handleContextMenu}
        onPointerEnter={handlePointerEnter}
        onPointerLeave={handlePointerLeave}
      >
        <title>{region.name || 'Region'}</title>
      </polygon>

      {/* Phase 52 SECRET-01: lock badge at centroid — owner-only, normal style intact (D-02).
          CRITICAL: React SVG only, no d3 datum handlers (memory: timeline-pins-react-rendered-no-d3-datum). */}
      {region.secret && !shareTokenForBadge && (
        <g transform={`translate(${centroidX},${centroidY})`} style={{ pointerEvents: 'none' }} aria-label="Secret">
          <circle r={8} fill="rgba(15,23,42,0.85)" />
          <path
            d="M-2.5,0.5 L-2.5,-2 A2.5,2.5 0 0,1 2.5,-2 L2.5,0.5"
            stroke="#f1f5f9"
            strokeWidth={1.2}
            fill="none"
            strokeLinecap="round"
          />
          <rect x="-3.5" y="0" width="7" height="5" rx="1" fill="#f1f5f9" />
          <circle cx={0} cy={2.5} r={1} fill="rgba(15,23,42,0.85)" />
        </g>
      )}
    </g>
  );
}

// ─── RoutePolyline ────────────────────────────────────────────────────────────
/**
 * React-rendered SVG polyline for a map route (ROUTE-01, Plan 06).
 *
 * CRITICAL: All interaction uses React event handlers (onClick, onContextMenu).
 * NEVER use d3 .on(event, (e, d) => ...) on this element — d is undefined on
 * React-rendered SVG and would throw (T-51-12, memory: timeline-pins-react-rendered-no-d3-datum).
 *
 * Two stacked path elements: a visible styled polyline (pointerEvents:'none') and a
 * fat transparent hit-stroke (strokeWidth=ROUTE_HIT_WIDTH) carrying handlers (D-07).
 * When isDrawing, BOTH paths set pointerEvents:'none' so clicks fall through to
 * handleSvgClick → vertex append (43-05 draw-mode fall-through).
 *
 * T-51-11: JSON.parse guard + min-2-point early return so malformed/short geometry renders null.
 * T-51-12: Label rendered as React text in <foreignObject> — no dangerouslySetInnerHTML.
 *
 * Optional end-arrowhead via SVG <marker> at the final vertex (showArrow=true).
 * Optional upright glassy label chip via <foreignObject> at the path midpoint (name!=='').
 */
interface RoutePolylineProps {
  route: MapRoute;
  imageWidth: number;
  imageHeight: number;
  isDrawing: boolean;
  onRouteClick: (route: MapRoute) => void;
  onRouteContextMenu: (route: MapRoute, clientX: number, clientY: number) => void;
  /** Called on pointer enter for tooltip overlay. */
  onRouteHoverEnter: (route: MapRoute, clientX: number, clientY: number) => void;
  /** Called on pointer leave to clear tooltip. */
  onRouteHoverLeave: () => void;
}

function RoutePolyline({
  route,
  imageWidth,
  imageHeight,
  isDrawing,
  onRouteClick,
  onRouteContextMenu,
  onRouteHoverEnter,
  onRouteHoverLeave,
}: RoutePolylineProps) {
  // Phase 52 SECRET-01: shareToken for lock-badge gate. Hook called unconditionally (React rules).
  const shareTokenForBadge = useShareToken();

  // T-51-11: Parse points JSON — malformed or short geometry renders null rather than throwing.
  let points: Array<{ x: number; y: number }> = [];
  try {
    points = JSON.parse(route.points) as Array<{ x: number; y: number }>;
  } catch {
    return null;
  }

  if (points.length < 2) return null;

  // Build SVG polyline points string in image-space coords.
  const svgPoints = points
    .map((p) => `${p.x * imageWidth},${p.y * imageHeight}`)
    .join(' ');

  const color = route.color ?? '#6b7280';

  // Pointer events: none when any draw mode active (draw-mode fall-through, 43-05 / D-07).
  const pointerEventsValue: React.CSSProperties['pointerEvents'] = isDrawing ? 'none' : 'auto';

  const handleClick = (e: React.MouseEvent) => {
    // While isDrawing: return early WITHOUT stopPropagation — click bubbles to handleSvgClick
    // → vertex append; no route navigation occurs (mirrors RegionPolygon 43-05 pattern).
    if (isDrawing) return;
    e.stopPropagation();
    onRouteClick(route);
  };

  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    onRouteContextMenu(route, e.clientX, e.clientY);
  };

  // Hover handlers — NEVER attach d3 .on(event,(e,d)=>) — d is undefined on React SVG.
  const handlePointerEnter = (e: React.PointerEvent) => {
    onRouteHoverEnter(route, e.clientX, e.clientY);
  };

  const handlePointerLeave = () => {
    onRouteHoverLeave();
  };

  // Midpoint for the label chip: midpoint of the middle segment.
  const midIdx = Math.floor((points.length - 1) / 2);
  const p0 = points[midIdx];
  const p1 = points[midIdx + 1];
  const midX = ((p0.x + p1.x) / 2) * imageWidth;
  const midY = ((p0.y + p1.y) / 2) * imageHeight;

  // T-51-12: Label rendered as React text — no dangerouslySetInnerHTML.
  const labelText =
    route.name.length > ROUTE_LABEL_MAX_CHARS
      ? route.name.slice(0, ROUTE_LABEL_MAX_CHARS) + '…'
      : route.name;

  // Unique per-route marker ID to avoid defs collisions across multiple routes.
  const markerId = `route-arrow-${route.id}`;

  return (
    <g style={{ cursor: route.entryId ? 'pointer' : 'default' }}>
      {/* Arrowhead marker definition — registered in-SVG-tree defs when showArrow */}
      {route.showArrow && (
        <defs>
          <marker
            id={markerId}
            markerWidth="10"
            markerHeight="7"
            refX="9"
            refY="3.5"
            orient="auto"
            markerUnits="strokeWidth"
          >
            <path d="M0,0 L0,7 L10,3.5 Z" fill={color} />
          </marker>
        </defs>
      )}

      {/* Visible styled polyline — pointerEvents:none so hit layer handles all interaction */}
      <polyline
        points={svgPoints}
        fill="none"
        stroke={color}
        strokeWidth={route.width}
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeDasharray={route.lineStyle === 'dashed' ? '8 6' : undefined}
        markerEnd={route.showArrow ? `url(#${markerId})` : undefined}
        style={{ pointerEvents: 'none' }}
      />

      {/* Fat transparent hit-stroke — carries all interaction handlers (D-07) */}
      {/* Both paths set pointerEvents:'none' when isDrawing (draw-mode fall-through, 43-05). */}
      <polyline
        points={svgPoints}
        fill="none"
        stroke="transparent"
        strokeWidth={ROUTE_HIT_WIDTH}
        strokeLinecap="round"
        style={{ pointerEvents: pointerEventsValue }}
        onClick={handleClick}
        onContextMenu={handleContextMenu}
        onPointerEnter={handlePointerEnter}
        onPointerLeave={handlePointerLeave}
      />

      {/* Upright midpoint label chip — shown when route.name !== '' (T-51-12, D-05) */}
      {/* Glassy chip matching Phase 50 chrome: bg/90 backdrop-blur + accent-color border. */}
      {/* Rendered as React text, NOT dangerouslySetInnerHTML — XSS safe. */}
      {route.name !== '' && (
        <foreignObject
          x={midX - 60}
          y={midY - 14}
          width={120}
          height={28}
          style={{ pointerEvents: 'none', overflow: 'visible' }}
        >
          <div
            className="route-label-chip"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              padding: '2px 8px',
              borderRadius: '4px',
              fontSize: '11px',
              fontWeight: 600,
              whiteSpace: 'nowrap',
              color: 'var(--color-text, #f1f5f9)',
              background: 'rgba(15, 23, 42, 0.9)',
              backdropFilter: 'blur(4px)',
              border: `1px solid ${color}`,
              lineHeight: '1.4',
            }}
          >
            {labelText}
          </div>
        </foreignObject>
      )}

      {/* Phase 52 SECRET-01: lock badge at route midpoint — owner-only, normal style intact (D-02).
          CRITICAL: React SVG only, no d3 datum handlers (memory: timeline-pins-react-rendered-no-d3-datum). */}
      {route.secret && !shareTokenForBadge && (
        <g transform={`translate(${midX + 14},${midY - 14})`} style={{ pointerEvents: 'none' }} aria-label="Secret">
          <circle r={8} fill="rgba(15,23,42,0.85)" />
          <path
            d="M-2.5,0.5 L-2.5,-2 A2.5,2.5 0 0,1 2.5,-2 L2.5,0.5"
            stroke="#f1f5f9"
            strokeWidth={1.2}
            fill="none"
            strokeLinecap="round"
          />
          <rect x="-3.5" y="0" width="7" height="5" rx="1" fill="#f1f5f9" />
          <circle cx={0} cy={2.5} r={1} fill="rgba(15,23,42,0.85)" />
        </g>
      )}
    </g>
  );
}

// ─── TerrainAreaPolygon ───────────────────────────────────────────────────────
/**
 * React-rendered SVG polygon for a terrain area (TERRAIN-03).
 *
 * CRITICAL: All interaction uses React event handlers (onClick, onContextMenu).
 * NEVER use d3 .on(event, (e, d) => ...) on this element — d is undefined on
 * React-rendered SVG and would throw (memory: timeline-pins-react-rendered-no-d3-datum).
 *
 * Borderless solid fill (stroke="none") in the terrain type's derived color.
 * Fill opacity is per-viewer (0..1). Right-click opens context menu (UNCHANGED in all modes).
 *
 * isDrawing gate (43-05): When isDrawing is true (addPinMode||drawRegionMode||paintTerrainMode),
 * the polygon sets pointerEvents:'none' so clicks fall through to the root <svg> onClick
 * (handleSvgClick → onCanvasClick → vertex append). The left-click handleClick no-op also
 * skips stopPropagation while isDrawing (belt-and-suspenders). When isDrawing is false,
 * left-click is still a passive no-op (stopPropagation fires, no vertex; terrain areas are
 * not click-to-navigate — D-43-04). onContextMenu is UNCHANGED in all modes.
 *
 * Renders BELOW political regions (inside terrain-areas group, before regions group).
 */
interface TerrainAreaPolygonProps {
  region: TerrainAreaRegion;
  imageWidth: number;
  imageHeight: number;
  viewerOpacity: number;
  isDrawing: boolean;
  onTerrainAreaContextMenu: (region: TerrainAreaRegion, clientX: number, clientY: number) => void;
}

function TerrainAreaPolygon({
  region,
  imageWidth,
  imageHeight,
  viewerOpacity,
  isDrawing,
  onTerrainAreaContextMenu,
}: TerrainAreaPolygonProps) {
  // Parse the points JSON string to [{x, y}] normalized 0..1 then convert to image space.
  // Wrapped in try/catch — malformed points render nothing rather than throwing (T-43-04).
  let points: Array<{ x: number; y: number }> = [];
  try {
    points = JSON.parse(region.points) as Array<{ x: number; y: number }>;
  } catch {
    return null;
  }

  if (points.length < 3) return null;

  // Build SVG polygon points string in image-space coords (same math as RegionPolygon).
  const svgPoints = points
    .map((p) => `${p.x * imageWidth},${p.y * imageHeight}`)
    .join(' ');

  const handleClick = (e: React.MouseEvent<SVGPolygonElement>) => {
    // Belt-and-suspenders: only stopPropagation when NOT drawing.
    // When isDrawing, return immediately so the click bubbles to handleSvgClick (43-05).
    if (isDrawing) return;
    e.stopPropagation();
  };

  const handleContextMenu = (e: React.MouseEvent<SVGPolygonElement>) => {
    e.preventDefault();
    e.stopPropagation();
    onTerrainAreaContextMenu(region, e.clientX, e.clientY);
  };

  return (
    <polygon
      points={svgPoints}
      fill={region.terrainTypeColor}   // derived color — NOT region.color (D-43-04)
      fillOpacity={viewerOpacity}       // per-viewer, 0..1
      stroke="none"                     // borderless (D-43-04)
      strokeWidth={0}
      style={{ cursor: 'default', pointerEvents: isDrawing ? 'none' : 'auto' }}
      onClick={handleClick}
      onContextMenu={handleContextMenu}
      role="none"
      aria-hidden="true"
    />
  );
}

// ─── MapCanvas ────────────────────────────────────────────────────────────────
/**
 * SVG canvas with d3-zoom/pan applied to the `<svg>` element only.
 * Pins and regions are React-rendered inside `<g class="pins">` / `<g class="regions">`
 * and use React event handlers exclusively — no d3 datum binding on any element.
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
 *
 * Z-ORDER (D-07): regions <g> is rendered BEFORE pins <g> so pins stay on top.
 */
export const MapCanvas = forwardRef<MapCanvasHandle, MapCanvasProps>(function MapCanvas({
  imageUrl,
  imageWidth,
  imageHeight,
  pins,
  regions,
  addPinMode,
  drawRegionMode,
  pendingVertices,
  selectedPinId,
  universeId,
  onCanvasClick,
  onPinDragEnd,
  onPinContextMenu,
  onRegionClick,
  onRegionContextMenu,
  terrainAreas = [],
  layerViewerState = {},
  paintTerrainMode = false,
  onTerrainAreaContextMenu,
  layers = [],
  gridVisible = false,
  routes = [],
  onRouteClick,
  onRouteContextMenu,
  drawRouteMode = false,
  onCanvasDblClick,
  onRouteVertexAtPin,
}, ref) {
  const svgRef = useRef<SVGSVGElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [currentScale, setCurrentScale] = useState(1);
  // Ref to the d3 zoomBehavior — lifted so imperative handle methods can call it (Task 1).
  const zoomBehaviorRef = useRef<ZoomBehavior<SVGSVGElement, unknown> | null>(null);
  // Pointer position in image space for rubber-band preview (drawRegionMode).
  const [pointerImgPos, setPointerImgPos] = useState<{ x: number; y: number } | null>(null);
  const navigate = useNavigate();

  // ── Hover tooltip state (D-07, D-08, Plan 04 Task 2) ──────────────────────────
  // Managed here (not in PinCircle/RegionPolygon) so the overlay renders outside the SVG.
  // Independent of the PinCircle dragging ref — hover callbacks skip during drag.
  const [hoveredTooltip, setHoveredTooltip] = useState<{
    title: string;
    type: string | undefined;
    summary: string | undefined | null;
    /** Client-space X (used with container-relative offset for positioning). */
    clientX: number;
    clientY: number;
  } | null>(null);
  // Share-token-aware navigation (T-40-14 / D-12): when a share token is present,
  // pin/region left-click navigates within /share/:token to avoid uid leaks.
  const shareToken = useShareToken();

  // isDrawing: true whenever any vertex-producing mode is active (43-05).
  // Mirrors the exact condition in handleSvgClick (~:491) — keep them consistent.
  // Used to gate pointerEvents on overlay polygons (TerrainAreaPolygon, RegionPolygon)
  // so clicks over existing areas fall through to handleSvgClick → onCanvasClick.
  // addPinMode is included because handleSvgClick already appends a pin/vertex for it
  // and a pin-placement click over a terrain area should also pass through.
  // isDrawing includes drawRouteMode so route elements set pointerEvents:'none'
  // during route draw, letting clicks fall through to handleSvgClick → vertex append.
  const isDrawing = addPinMode || drawRegionMode || drawRouteMode || paintTerrainMode;

  // Ref mirror of isDrawing — read by the d3 zoom .filter() closure so the zoom behavior
  // always sees the LIVE draw-mode state without being torn down and recreated (which would
  // lose the current pan/zoom transform). Updated by a separate useEffect each render so it
  // is consistent with isDrawing but does NOT appear in the zoom-effect deps array.
  // BUG-A fix (51-07).
  const isDrawingRef = useRef(isDrawing);
  useEffect(() => {
    isDrawingRef.current = isDrawing;
  }, [isDrawing]);

  // Install d3-zoom on the svg element, targeting <g.viewport>.
  // Pins and regions are React-rendered inside this effect's SVG structure but are
  // NOT touched by d3 — d3 only manages the zoom transform on <g.viewport>.
  // zoomBehavior is lifted to zoomBehaviorRef so imperative handle methods can call it (Task 1).
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
      // BUG-A fix (51-07): disable d3 pan-start gestures while any draw mode is active.
      // The closure reads isDrawingRef.current so it always sees the live value without
      // the zoom behavior being torn down (which would lose the current transform).
      // deps are [imageWidth, imageHeight] only — DO NOT add mode flags here.
      // Wheel events always pass through so scroll-to-zoom works in all modes.
      // When not drawing, restore d3's default filter (primary button, no Ctrl).
      .filter((event) => {
        if (event.type === 'wheel') return true;
        if (isDrawingRef.current) return false;
        // d3 default: primary button only, no Ctrl modifier.
        return !event.ctrlKey && !event.button;
      })
      .on('zoom', (evt) => {
        g.attr('transform', evt.transform.toString());
        setCurrentScale(evt.transform.k);
      });

    // Lift into ref so useImperativeHandle can access it without closure staleness.
    zoomBehaviorRef.current = zoomBehavior;

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
      zoomBehaviorRef.current = null;
    };
  }, [imageWidth, imageHeight]);

  // ── Imperative zoom handle (Task 1: D-05 seam for MapZoomControls) ───────────
  // Exposes zoomIn / zoomOut / fitReset so MapEditor can wire MapZoomControls
  // buttons directly to the d3 zoomBehavior without prop-drilling callbacks.
  useImperativeHandle(ref, () => ({
    zoomIn() {
      if (!svgRef.current || !zoomBehaviorRef.current) return;
      zoomBehaviorRef.current.scaleBy(select(svgRef.current), 1.3);
    },
    zoomOut() {
      if (!svgRef.current || !zoomBehaviorRef.current) return;
      zoomBehaviorRef.current.scaleBy(select(svgRef.current), 1 / 1.3);
    },
    fitReset() {
      if (!svgRef.current || !zoomBehaviorRef.current) return;
      const svgEl = svgRef.current;
      const svg = select(svgEl);
      const vw = svgEl.clientWidth || svgEl.getBoundingClientRect().width;
      const vh = svgEl.clientHeight || svgEl.getBoundingClientRect().height;
      if (vw > 0 && vh > 0) {
        const scale = Math.min(vw / imageWidth, vh / imageHeight);
        zoomBehaviorRef.current.translateTo(svg, imageWidth / 2, imageHeight / 2);
        zoomBehaviorRef.current.scaleTo(svg, scale);
      }
    },
  }), [imageWidth, imageHeight]);

  // ── Coordinate conversion helper ─────────────────────────────────────────────
  // Two-step screen → image space conversion (Approach A).
  // Used by both handleSvgClick and handleSvgPointerMove.
  const screenToImage = (clientX: number, clientY: number): { nx: number; ny: number } | null => {
    const svgEl = svgRef.current;
    if (!svgEl) return null;

    const pt = svgEl.createSVGPoint();
    pt.x = clientX;
    pt.y = clientY;

    // Step 1: screen → SVG-ROOT space (NOT yet image space).
    const screenCTM = svgEl.getScreenCTM();
    if (!screenCTM) return null;
    const root = pt.matrixTransform(screenCTM.inverse());

    // Step 2: undo the d3 zoom transform (which lives on <g.viewport>) → IMAGE space.
    const [imgX, imgY] = zoomTransform(svgEl).invert([root.x, root.y]);

    const nx = clamp(imgX / imageWidth, 0, 1);
    const ny = clamp(imgY / imageHeight, 0, 1);
    return { nx, ny };
  };

  // CANVAS CLICK — COORDINATE CONVERSION (Approach A — two-step).
  // Fires when addPinMode, drawRegionMode, or paintTerrainMode is active.
  // paintTerrainMode reuses the same onCanvasClick vertex-append pipeline as drawRegionMode
  // (the MapEditor onCanvasClick handler branches on armed state).
  const handleSvgClick = (e: React.MouseEvent<SVGSVGElement>) => {
    if (!addPinMode && !drawRegionMode && !drawRouteMode && !paintTerrainMode) return;
    // Ignore clicks that originated on a pin group (they handle their own events).
    if ((e.target as Element).closest('g[aria-label]')) return;

    const pos = screenToImage(e.clientX, e.clientY);
    if (!pos) return;
    onCanvasClick(pos.nx, pos.ny);
  };

  // POINTER MOVE — track cursor in image space for rubber-band preview.
  // Active in drawRegionMode AND paintTerrainMode (shared vertex-snap preview).
  // dblclick finisher for route draw — d3's dblclick-to-zoom is already suppressed.
  // Only fires when drawRouteMode is active; delegates to MapEditor's handler.
  const handleSvgDblClick = (e: React.MouseEvent<SVGSVGElement>) => {
    if (!drawRouteMode) return;
    e.stopPropagation();
    onCanvasDblClick?.();
  };

  const handleSvgPointerMove = (e: React.PointerEvent<SVGSVGElement>) => {
    if (!drawRegionMode && !drawRouteMode && !paintTerrainMode) return;
    const pos = screenToImage(e.clientX, e.clientY);
    if (pos) setPointerImgPos({ x: pos.nx * imageWidth, y: pos.ny * imageHeight });
  };

  // Navigate to entry — share-token-aware (T-40-14).
  // In share mode: /share/:token/entries/:entryId (no uid leak to visitor).
  // In authenticated mode: /universes/:uid/entries/:entryId.
  const handleNavigate = (entryId: string) => {
    if (shareToken) {
      navigate(`/share/${shareToken}/entries/${entryId}`);
    } else {
      navigate(`/universes/${universeId}/entries/${entryId}`);
    }
  };

  // ── Hover tooltip callbacks (D-07, D-08) ──────────────────────────────────────
  // T-50-07: summary rendered as React text child — auto-escaped, NEVER dangerouslySetInnerHTML.
  // Callbacks are stable via useCallback so PinCircle/RegionPolygon renders are not spurious.
  const handlePinHoverEnter = useCallback((pin: MapPin, clientX: number, clientY: number) => {
    setHoveredTooltip({
      title: pin.entryTitle ?? 'Pin',
      type: pin.entryType,
      summary: pin.summary,
      clientX,
      clientY,
    });
  }, []);

  const handleRegionHoverEnter = useCallback((region: MapRegion, clientX: number, clientY: number) => {
    setHoveredTooltip({
      title: region.name || 'Region',
      type: undefined,
      summary: undefined,
      clientX,
      clientY,
    });
  }, []);

  // Phase 51 ROUTE-01: route hover handler — shows route name in tooltip.
  const handleRouteHoverEnter = useCallback((route: MapRoute, clientX: number, clientY: number) => {
    setHoveredTooltip({
      title: route.name || 'Route',
      type: undefined,
      summary: undefined,
      clientX,
      clientY,
    });
  }, []);

  const handleHoverLeave = useCallback(() => {
    setHoveredTooltip(null);
  }, []);

  // ── Rubber-band preview helpers ──────────────────────────────────────────────
  // Convert pending vertices (normalized) to image-space SVG points string.
  const pendingPoints = pendingVertices
    .map((p) => `${p.x * imageWidth},${p.y * imageHeight}`)
    .join(' ');

  // First-vertex snap affordance — check if pointer is near the first vertex.
  // Active in drawRegionMode and paintTerrainMode (same vertex snap behavior).
  const isNearFirstVertex =
    (drawRegionMode || paintTerrainMode) &&
    pendingVertices.length >= 3 &&
    pointerImgPos !== null &&
    (() => {
      const fv = pendingVertices[0];
      const dx = pointerImgPos.x - fv.x * imageWidth;
      const dy = pointerImgPos.y - fv.y * imageHeight;
      return Math.sqrt(dx * dx + dy * dy) < SNAP_DISTANCE_PX / currentScale;
    })();

  // Preview shape includes the current pointer as a trailing vertex for rubber-band effect.
  // drawRouteMode is included so the open-polyline preview also tracks the cursor.
  const previewPoints =
    (drawRegionMode || drawRouteMode || paintTerrainMode) && pendingVertices.length > 0 && pointerImgPos
      ? pendingPoints + ` ${pointerImgPos.x},${pointerImgPos.y}`
      : pendingPoints;

  // The region draw preview color uses the accent color.
  const previewColor = 'var(--color-accent, #3b82f6)';

  // Compute tooltip position relative to the container div.
  // getBoundingClientRect() returns zeros in jsdom — that's fine for tests (tooltip still renders).
  const tooltipStyle = hoveredTooltip ? (() => {
    const rect = containerRef.current?.getBoundingClientRect();
    const left = hoveredTooltip.clientX - (rect?.left ?? 0) + 14;
    const top = hoveredTooltip.clientY - (rect?.top ?? 0) + 14;
    return { left, top } as React.CSSProperties;
  })() : undefined;

  // Whether the summary excerpt should render (D-08):
  // non-empty string only — empty string, null, undefined all suppress the excerpt line.
  const hasExcerpt =
    hoveredTooltip?.summary != null &&
    hoveredTooltip.summary.trim().length > 0;

  // Truncate summary to ~120 chars to keep the tooltip compact.
  const excerptText =
    hasExcerpt && hoveredTooltip!.summary!.length > 120
      ? hoveredTooltip!.summary!.slice(0, 120) + '…'
      : hoveredTooltip?.summary ?? '';

  return (
    // Container div: fills parent, provides positioning context for the tooltip overlay.
    // height/width inherit from the SVG's h-full w-full, matching prior layout.
    <div ref={containerRef} className="relative h-full w-full">
    <svg
      ref={svgRef}
      role="application"
      aria-label="Map canvas"
      className={[
        'block h-full w-full select-none',
        addPinMode || drawRegionMode || drawRouteMode || paintTerrainMode ? 'cursor-crosshair' : '',
      ]
        .filter(Boolean)
        .join(' ')}
      onClick={handleSvgClick}
      onDoubleClick={handleSvgDblClick}
      onPointerMove={handleSvgPointerMove}
    >
      {/* ── SVG filter definitions (D-03) ──────────────────────────────────── */}
      {/* Placed OUTSIDE <g.viewport> so they are not zoom-transformed.        */}
      <defs>
        {/* Drop shadow — always applied to the teardrop marker.
            Colors driven by CSS custom properties (Task 3 design tokens). */}
        <filter id="pin-shadow" x="-30%" y="-30%" width="160%" height="160%">
          <feDropShadow
            dx="0"
            dy="2"
            stdDeviation="2"
            floodColor="var(--pin-shadow-color, rgba(0,0,0,0.5))"
            floodOpacity="1"
          />
        </filter>

        {/* Selection glow — applied to a blurred copy behind the marker when selected.
            Uses accent color by default; overridden by --pin-glow-color token (Task 3). */}
        <filter id="pin-glow" x="-60%" y="-60%" width="220%" height="220%">
          <feGaussianBlur stdDeviation="4" in="SourceGraphic" result="blur" />
          <feFlood floodColor="var(--pin-glow-color, oklch(0.6 0.18 270))" floodOpacity="0.75" result="color" />
          <feComposite in="color" in2="blur" operator="in" result="coloredBlur" />
          <feMerge>
            <feMergeNode in="coloredBlur" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>

      <g className="viewport">
        {/* Map background image layer — omitted when imageUrl is absent (backing asset deleted). */}
        {imageUrl ? (
          <image
            href={imageUrl}
            x="0"
            y="0"
            width={imageWidth}
            height={imageHeight}
            preserveAspectRatio="xMidYMid meet"
          />
        ) : (
          <rect
            x="0"
            y="0"
            width={imageWidth}
            height={imageHeight}
            fill="var(--color-surface, #1a1a2e)"
            opacity={0.4}
          />
        )}

        {/* ── Optional image-space grid overlay (D-05, Task 1) ── */}
        {/* Placed INSIDE <g.viewport> so it pans/zooms with the map (image space). */}
        {/* After background image, BEFORE terrain areas and regions. */}
        {/* pointerEvents:'none' — never blocks d3-zoom or pin/region interaction (T-50-03). */}
        {gridVisible && (() => {
          const vLines: number[] = [];
          const hLines: number[] = [];
          for (let x = 0; x <= imageWidth; x += GRID_PX) vLines.push(x);
          for (let y = 0; y <= imageHeight; y += GRID_PX) hLines.push(y);
          return (
            <g className="grid-overlay" style={{ pointerEvents: 'none' }}>
              {vLines.map((x) => (
                <line
                  key={`v${x}`}
                  x1={x} y1={0}
                  x2={x} y2={imageHeight}
                  stroke="var(--map-grid-color, rgba(120,120,120,0.18))"
                  strokeWidth={1}
                />
              ))}
              {hLines.map((y) => (
                <line
                  key={`h${y}`}
                  x1={0} y1={y}
                  x2={imageWidth} y2={y}
                  stroke="var(--map-grid-color, rgba(120,120,120,0.18))"
                  strokeWidth={1}
                />
              ))}
            </g>
          );
        })()}

        {/* ── Terrain areas — rendered BELOW regions (D-07, TERRAIN-03) ── */}
        {/* Stacked bottom-to-top by layer sortOrder; hidden layers render nothing. */}
        {/* CRITICAL: React handlers only — NEVER d3 .on(event,(e,d)=>) here */}
        <g className="terrain-areas">
          {[...layers]
            .sort((a, b) => a.sortOrder - b.sortOrder)
            .map((layer) => {
              if (!layerViewerState[layer.id]?.visible) return null;   // hidden layer → render nothing
              const viewerOpacity = layerViewerState[layer.id]?.opacity ?? 0.6;
              const layerAreas = terrainAreas.filter((a) => a.layerId === layer.id);
              return (
                <g key={layer.id} data-layer-id={layer.id}>
                  {layerAreas.map((area) => (
                    <TerrainAreaPolygon
                      key={area.id}
                      region={area}
                      imageWidth={imageWidth}
                      imageHeight={imageHeight}
                      viewerOpacity={viewerOpacity}
                      isDrawing={isDrawing}
                      onTerrainAreaContextMenu={onTerrainAreaContextMenu ?? (() => {})}
                    />
                  ))}
                </g>
              );
            })}
        </g>

        {/* ── Regions — rendered BEFORE pins so pins stay on top (D-07) ── */}
        <g className="regions">
          {regions.map((region) => (
            <RegionPolygon
              key={region.id}
              region={region}
              imageWidth={imageWidth}
              imageHeight={imageHeight}
              isDrawing={isDrawing}
              onRegionClick={onRegionClick}
              onRegionContextMenu={onRegionContextMenu}
              onRegionHoverEnter={handleRegionHoverEnter}
              onRegionHoverLeave={handleHoverLeave}
            />
          ))}
        </g>

        {/* ── Routes — rendered ABOVE regions, BELOW pins (D-08 stacking, ROUTE-01) ── */}
        {/* CRITICAL: React handlers only — NEVER d3 .on(event,(e,d)=>) on route elements. */}
        <g className="routes">
          {routes.map((route) => (
            <RoutePolyline
              key={route.id}
              route={route}
              imageWidth={imageWidth}
              imageHeight={imageHeight}
              isDrawing={isDrawing}
              onRouteClick={onRouteClick ?? (() => {})}
              onRouteContextMenu={onRouteContextMenu ?? (() => {})}
              onRouteHoverEnter={handleRouteHoverEnter}
              onRouteHoverLeave={handleHoverLeave}
            />
          ))}
        </g>

        {/* ── Rubber-band preview (drawRegionMode, drawRouteMode, or paintTerrainMode) ── */}
        {/* Reuse the same vertex snap circles and accent stroke for all draw modes. */}
        {/* CRITICAL: React handlers only — NEVER d3 .on(event,(e,d)=>) here */}
        {(drawRegionMode || drawRouteMode || paintTerrainMode) && pendingVertices.length > 0 && (
          <g className="region-preview">
            {/* Preview shape: open polyline for routes (never closes), closed polygon for regions/terrain.
                BUG-1 fix: route draw must NOT render a <polygon> — <polygon> auto-closes the shape and
                fills it, making the preview look like a closed polygon instead of an open path. */}
            {drawRouteMode ? (
              <polyline
                points={previewPoints}
                fill="none"
                stroke={previewColor}
                strokeWidth={1.5}
                strokeDasharray="4 3"
                strokeLinecap="round"
                strokeLinejoin="round"
                style={{ pointerEvents: 'none' }}
              />
            ) : (
              <polygon
                points={previewPoints}
                fill={previewColor}
                fillOpacity={0.15}
                stroke={previewColor}
                strokeWidth={1.5}
                strokeDasharray="4 3"
                style={{ pointerEvents: 'none' }}
              />
            )}
            {/* Vertex handle circles — React-rendered, React handlers only */}
            {pendingVertices.map((v, idx) => {
              const vx = v.x * imageWidth;
              const vy = v.y * imageHeight;
              const isFirst = idx === 0;
              const isSnapped = isFirst && isNearFirstVertex;
              return (
                <circle
                  key={idx}
                  cx={vx}
                  cy={vy}
                  r={isSnapped ? 8 / currentScale : 5 / currentScale}
                  fill={isSnapped ? previewColor : '#ffffff'}
                  stroke={previewColor}
                  strokeWidth={1.5 / currentScale}
                  // Route mode: no snap-to-first-vertex affordance — routes finish via Enter/dblclick,
                  // never by snapping back to the first vertex. No pointer cursor, no 'Close polygon' label.
                  style={{ cursor: isFirst && !drawRouteMode && pendingVertices.length >= 3 ? 'pointer' : 'default', pointerEvents: 'none' }}
                  aria-label={isFirst && !drawRouteMode ? 'Close polygon' : `Vertex ${idx + 1}`}
                />
              );
            })}
          </g>
        )}

        {/* ── React-rendered pins — ABOVE regions, NO d3 datum binding ── */}
        <g className="pins">
          {pins.map((pin) => (
            <PinCircle
              key={pin.id}
              pin={pin}
              onPinHoverEnter={handlePinHoverEnter}
              onPinHoverLeave={handleHoverLeave}
              imageWidth={imageWidth}
              imageHeight={imageHeight}
              currentScale={currentScale}
              selected={selectedPinId === pin.id}
              universeId={universeId}
              onNavigate={handleNavigate}
              onDragEnd={onPinDragEnd}
              onContextMenu={onPinContextMenu}
              drawRouteMode={drawRouteMode}
              onRouteVertexAtPin={onRouteVertexAtPin}
            />
          ))}
        </g>
      </g>
    </svg>

    {/* ── Hover tooltip overlay (D-07, D-08, Plan 04 Task 2) ── */}
    {/* pointer-events-none wrapper: d3-zoom and pin drag must NEVER be blocked (MapLegend 148 guard). */}
    {/* T-50-07: summary rendered as React text children — auto-escaped, NEVER dangerouslySetInnerHTML. */}
    <div className="pointer-events-none absolute inset-0">
      {hoveredTooltip && (
        <div
          data-testid="map-tooltip"
          className="pointer-events-none absolute z-50 max-w-[200px] rounded-md border border-neutral-200 bg-white/90 backdrop-blur-sm shadow-sm dark:border-neutral-800 dark:bg-neutral-900/90 px-3 py-2"
          style={tooltipStyle}
        >
          {/* Title — always shown (D-07, D-08) */}
          <p className="text-xs font-semibold text-neutral-900 dark:text-neutral-100 truncate">
            {hoveredTooltip.title}
          </p>
          {/* Entry type — shown when present (pin type; regions may not have it) */}
          {hoveredTooltip.type && (
            <p className="text-xs capitalize text-neutral-500 dark:text-neutral-400">
              {hoveredTooltip.type}
            </p>
          )}
          {/* Summary excerpt — ONLY when summary is a non-empty string (D-08).
              Empty string / null / undefined → NO excerpt, NO placeholder. */}
          {hasExcerpt && (
            <p
              data-testid="tooltip-excerpt"
              className="mt-1 text-xs text-neutral-600 dark:text-neutral-300 line-clamp-2"
            >
              {excerptText}
            </p>
          )}
        </div>
      )}
    </div>
    </div>
  );
});
