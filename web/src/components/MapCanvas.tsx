import { useEffect, useRef, useState } from 'react';
import { select } from 'd3-selection';
import { zoom, zoomTransform, type ZoomBehavior } from 'd3-zoom';
import { useNavigate } from 'react-router-dom';
import { entryTypeHexColor } from '../lib/entryTypeColor';
import { GlyphIcon } from '../lib/mapGlyphs';
import type { MapPin, MapRegion, TerrainAreaRegion } from '../hooks/useMap';
import type { MapLayer } from '../hooks/useMapLayers';
import { useShareToken } from '../contexts/ShareModeContext';

// ─── Constants ────────────────────────────────────────────────────────────────
const NODE_RADIUS = 14;        // matches DiagramCanvas NODE_RADIUS
const HIT_RADIUS = 22;         // transparent hit area — 44px diameter touch target
const SELECTION_RING_R = 18;   // HALO_RADIUS in DiagramCanvas terms
const DRAG_THRESHOLD_PX = 4;   // pointer movement below this is treated as a click
const SNAP_DISTANCE_PX = 18;   // first-vertex snap radius in IMAGE pixels (scaled)

/** Clamp a number to [lo, hi]. */
function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
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

  // Pin color: explicit override or fallback to entry type color (D-01)
  const pinColor = pin.color ?? entryTypeHexColor(pin.entryType ?? 'concept');

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

      {/* Visible pin circle with color override (D-01) */}
      <circle
        r={NODE_RADIUS}
        fill={pinColor}
        stroke="#111827"
        strokeWidth={1}
      />

      {/* Glyph icon overlay — rendered when pin.icon is set (D-02) */}
      {pin.icon && (
        <foreignObject
          x={-8}
          y={-8}
          width={16}
          height={16}
          style={{ pointerEvents: 'none', overflow: 'visible' }}
        >
          <GlyphIcon glyph={pin.icon} size={16} color="#fff" />
        </foreignObject>
      )}

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
 */
interface RegionPolygonProps {
  region: MapRegion;
  imageWidth: number;
  imageHeight: number;
  onRegionClick: (region: MapRegion) => void;
  onRegionContextMenu: (region: MapRegion, clientX: number, clientY: number) => void;
}

function RegionPolygon({
  region,
  imageWidth,
  imageHeight,
  onRegionClick,
  onRegionContextMenu,
}: RegionPolygonProps) {
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

  const handleClick = (e: React.MouseEvent<SVGPolygonElement>) => {
    e.stopPropagation();
    onRegionClick(region);
  };

  const handleContextMenu = (e: React.MouseEvent<SVGPolygonElement>) => {
    e.preventDefault();
    e.stopPropagation();
    onRegionContextMenu(region, e.clientX, e.clientY);
  };

  return (
    <polygon
      points={svgPoints}
      fill={color}
      fillOpacity={0.18}
      stroke={color}
      strokeWidth={1.5}
      strokeOpacity={1}
      style={{ cursor: region.entryId ? 'pointer' : 'default' }}
      onClick={handleClick}
      onContextMenu={handleContextMenu}
    >
      <title>{region.name || 'Region'}</title>
    </polygon>
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
 * Fill opacity is per-viewer (0..1). Left-click is a no-op (passive, stops propagation
 * to prevent canvas-level draw-vertex from firing). Right-click opens context menu.
 * Renders BELOW political regions (inside terrain-areas group, before regions group).
 */
interface TerrainAreaPolygonProps {
  region: TerrainAreaRegion;
  imageWidth: number;
  imageHeight: number;
  viewerOpacity: number;
  onTerrainAreaContextMenu: (region: TerrainAreaRegion, clientX: number, clientY: number) => void;
}

function TerrainAreaPolygon({
  region,
  imageWidth,
  imageHeight,
  viewerOpacity,
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
    // Passive — stops propagation to prevent canvas-level draw-vertex from firing.
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
      style={{ cursor: 'default', pointerEvents: 'auto' }}
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
export function MapCanvas({
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
}: MapCanvasProps) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [currentScale, setCurrentScale] = useState(1);
  // Pointer position in image space for rubber-band preview (drawRegionMode).
  const [pointerImgPos, setPointerImgPos] = useState<{ x: number; y: number } | null>(null);
  const navigate = useNavigate();
  // Share-token-aware navigation (T-40-14 / D-12): when a share token is present,
  // pin/region left-click navigates within /share/:token to avoid uid leaks.
  const shareToken = useShareToken();

  // Install d3-zoom on the svg element, targeting <g.viewport>.
  // Pins and regions are React-rendered inside this effect's SVG structure but are
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
    if (!addPinMode && !drawRegionMode && !paintTerrainMode) return;
    // Ignore clicks that originated on a pin group (they handle their own events).
    if ((e.target as Element).closest('g[aria-label]')) return;

    const pos = screenToImage(e.clientX, e.clientY);
    if (!pos) return;
    onCanvasClick(pos.nx, pos.ny);
  };

  // POINTER MOVE — track cursor in image space for rubber-band preview.
  // Active in drawRegionMode AND paintTerrainMode (shared vertex-snap preview).
  const handleSvgPointerMove = (e: React.PointerEvent<SVGSVGElement>) => {
    if (!drawRegionMode && !paintTerrainMode) return;
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

  // Preview polygon includes the current pointer as a trailing vertex for rubber-band effect.
  const previewPoints =
    (drawRegionMode || paintTerrainMode) && pendingVertices.length > 0 && pointerImgPos
      ? pendingPoints + ` ${pointerImgPos.x},${pointerImgPos.y}`
      : pendingPoints;

  // The region draw preview color uses the accent color.
  const previewColor = 'var(--color-accent, #3b82f6)';

  return (
    <svg
      ref={svgRef}
      role="application"
      aria-label="Map canvas"
      className={[
        'block h-full w-full select-none',
        addPinMode || drawRegionMode || paintTerrainMode ? 'cursor-crosshair' : '',
      ]
        .filter(Boolean)
        .join(' ')}
      onClick={handleSvgClick}
      onPointerMove={handleSvgPointerMove}
    >
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
              onRegionClick={onRegionClick}
              onRegionContextMenu={onRegionContextMenu}
            />
          ))}
        </g>

        {/* ── Rubber-band preview polygon (drawRegionMode or paintTerrainMode) ── */}
        {/* Reuse the same vertex snap circles and accent stroke for both modes. */}
        {/* CRITICAL: React handlers only — NEVER d3 .on(event,(e,d)=>) here */}
        {(drawRegionMode || paintTerrainMode) && pendingVertices.length > 0 && (
          <g className="region-preview">
            {/* Preview polygon */}
            <polygon
              points={previewPoints}
              fill={previewColor}
              fillOpacity={0.15}
              stroke={previewColor}
              strokeWidth={1.5}
              strokeDasharray="4 3"
              style={{ pointerEvents: 'none' }}
            />
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
                  style={{ cursor: isFirst && pendingVertices.length >= 3 ? 'pointer' : 'default', pointerEvents: 'none' }}
                  aria-label={isFirst ? 'Close polygon' : `Vertex ${idx + 1}`}
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
