import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { select } from 'd3-selection';
import { zoom, zoomTransform, type ZoomBehavior } from 'd3-zoom';
import { useNavigate } from 'react-router-dom';
import { entryTypeHexColor } from '../lib/entryTypeColor';
import { GlyphIcon } from '../lib/mapGlyphs';
import type { MapPin, MapRegion, TerrainAreaRegion, MapRoute } from '../hooks/useMap';
import type { MapLayer } from '../hooks/useMapLayers';
import { useShareToken } from '../contexts/ShareModeContext';
import { Medallion } from './Medallion';
import { TypeBadge } from './TypeBadge';
import type { MedallionSource } from '../lib/medallion';

const HIT_RADIUS = 22; // transparent hit area — 44px diameter touch target
const DRAG_THRESHOLD_PX = 4; // pointer movement below this is treated as a click
const SNAP_DISTANCE_PX = 18; // first-vertex snap radius in IMAGE pixels (scaled)
const GRID_PX = 100; // grid spacing in image pixels (T-50-03: bounded by imageWidth/GRID_PX)
const ROUTE_HIT_WIDTH = 20; // wide transparent hit-stroke for route polylines (image-space units)
const ROUTE_LABEL_MAX_CHARS = 24; // label truncation length for route midpoint chip

const TEARDROP_D =
  'M 0 0 C -5 -6,-11 -14,-11 -20 A 11 11 0 1 0 11 -20 C 11 -14,5 -6,0 0 Z';

const GLYPH_OFFSET_X = -8;
const GLYPH_OFFSET_Y = -26;

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

export interface MapCanvasHandle {
  zoomIn(): void;
  zoomOut(): void;
  fitReset(): void;
  panZoomTo(nx: number, ny: number): void;
}

const PAN_ZOOM_TARGET_SCALE = 2.5;

export interface MapCanvasProps {
  imageUrl: string | null;
  imageWidth: number;
  imageHeight: number;
  pins: MapPin[];
  regions: MapRegion[];
  addPinMode: boolean;
  drawRegionMode: boolean;
  pendingVertices: Array<{ x: number; y: number }>;
  selectedPinId: string | null;
  universeId: string;
  medallions?: Map<string, MedallionSource>;
  onCanvasClick: (nx: number, ny: number) => void;
  onPinDragEnd: (pinId: string, nx: number, ny: number) => void;
  onPinContextMenu: (pin: MapPin, clientX: number, clientY: number) => void;
  onRegionClick: (region: MapRegion) => void;
  onRegionContextMenu: (region: MapRegion, clientX: number, clientY: number) => void;

  terrainAreas?: TerrainAreaRegion[];
  layerViewerState?: Record<string, { visible: boolean; opacity: number }>;
  paintTerrainMode?: boolean;
  onTerrainAreaContextMenu?: (region: TerrainAreaRegion, clientX: number, clientY: number) => void;
  layers?: MapLayer[];
  gridVisible?: boolean;

  routes?: MapRoute[];
  onRouteClick?: (route: MapRoute) => void;
  onRouteContextMenu?: (route: MapRoute, clientX: number, clientY: number) => void;
  drawRouteMode?: boolean;
  onCanvasDblClick?: () => void;
  onRouteVertexAtPin?: (pin: MapPin) => void;

  highlightedItemId?: string | null;

  onOpenMap?: (targetMapId: string) => void;
}

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
  onPinHoverEnter: (pin: MapPin, clientX: number, clientY: number) => void;
  onPinHoverLeave: () => void;
  drawRouteMode?: boolean;
  onRouteVertexAtPin?: (pin: MapPin) => void;
  onOpenMap?: (targetMapId: string) => void;
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
  onOpenMap,
}: PinCircleProps) {
  const pinColor = pin.color ?? entryTypeHexColor(pin.entryType ?? 'concept');
  const shareTokenForBadge = useShareToken();

  const [dragVisualX, setDragVisualX] = useState<number | null>(null);
  const [dragVisualY, setDragVisualY] = useState<number | null>(null);

  const pinX = dragVisualX !== null ? dragVisualX : pin.x * imageWidth;
  const pinY = dragVisualY !== null ? dragVisualY : pin.y * imageHeight;

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
    if (drawRouteMode) return;
    const dx = e.clientX - dragStart.current.clientX;
    const dy = e.clientY - dragStart.current.clientY;
    if (Math.abs(dx) > DRAG_THRESHOLD_PX || Math.abs(dy) > DRAG_THRESHOLD_PX) {
      dragStart.current.moved = true;
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

    setDragVisualX(null);
    setDragVisualY(null);

    if (!start.moved) {
      if (drawRouteMode) {
        onRouteVertexAtPin?.(pin);
        return;
      }
      if (pin.targetMapId) { onOpenMap?.(pin.targetMapId); return; }
      if (pin.entryId) onNavigate(pin.entryId);
      return;
    }

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

  const handlePointerEnter = (e: React.PointerEvent<SVGGElement>) => {
    if (dragging.current) return;
    onPinHoverEnter(pin, e.clientX, e.clientY);
  };

  const handlePointerLeave = () => {
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

      {/* Phase 53 NEST-01: nested-map badge — visible to share visitors (NO share gate, unlike secret badge).
          Position: top-LEFT translate(-10,-30) vs lock badge top-right. Both may render simultaneously without overlap.
          CRITICAL: React SVG only — NEVER d3 .on(event,(e,d)=>) (memory: timeline-pins-react-rendered-no-d3-datum). */}
      {pin.targetMapId && (
        <g transform="translate(-10,-30)" style={{ pointerEvents: 'none' }} aria-label="Opens map">
          {/* Accent violet chip (UI-SPEC §4) */}
          <circle r={7} fill="oklch(0.6 0.18 270)" />
          {/* Stacked-maps glyph: two offset rounded squares, decorative (UI-SPEC §4) */}
          <g aria-hidden="true">
            {/* Back square */}
            <rect x={-1} y={-3} width={6} height={6} rx={1} stroke="#f1f5f9" strokeWidth={1.2} fill="none" />
            {/* Front square */}
            <rect x={-3} y={-1} width={6} height={6} rx={1} stroke="#f1f5f9" strokeWidth={1.2} fill="none" />
          </g>
        </g>
      )}
    </g>
  );
}

interface RegionPolygonProps {
  region: MapRegion;
  imageWidth: number;
  imageHeight: number;
  isDrawing: boolean;
  onRegionClick: (region: MapRegion) => void;
  onRegionContextMenu: (region: MapRegion, clientX: number, clientY: number) => void;
  onRegionHoverEnter: (region: MapRegion, clientX: number, clientY: number) => void;
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
  const shareTokenForBadge = useShareToken();

  let points: Array<{ x: number; y: number }> = [];
  try {
    points = JSON.parse(region.points) as Array<{ x: number; y: number }>;
  } catch {
    return null;
  }

  if (points.length < 3) return null;

  const svgPoints = points
    .map((p) => `${p.x * imageWidth},${p.y * imageHeight}`)
    .join(' ');

  const color = region.color ?? '#6b7280';

  const centroidX = points.reduce((s, p) => s + p.x * imageWidth, 0) / points.length;
  const centroidY = points.reduce((s, p) => s + p.y * imageHeight, 0) / points.length;

  const handleClick = (e: React.MouseEvent<SVGPolygonElement>) => {
    if (isDrawing) return;
    e.stopPropagation();
    onRegionClick(region);
  };

  const handleContextMenu = (e: React.MouseEvent<SVGPolygonElement>) => {
    e.preventDefault();
    e.stopPropagation();
    onRegionContextMenu(region, e.clientX, e.clientY);
  };

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
          cursor: (region.entryId || region.targetMapId) ? 'pointer' : 'default',
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

      {/* Phase 53 NEST-01: nested-map badge at centroid offset (-14,-14) — up-left of lock (lock stays at centroid).
          NO share gate — visible to visitors (unlike secret badge). Both may render simultaneously without overlap.
          CRITICAL: React SVG only — NEVER d3 .on(event,(e,d)=>) (memory: timeline-pins-react-rendered-no-d3-datum). */}
      {region.targetMapId && (
        <g transform={`translate(${centroidX - 14},${centroidY - 14})`} style={{ pointerEvents: 'none' }} aria-label="Opens map">
          {/* Accent violet chip (UI-SPEC §4) */}
          <circle r={7} fill="oklch(0.6 0.18 270)" />
          {/* Stacked-maps glyph: two offset rounded squares, decorative (UI-SPEC §4) */}
          <g aria-hidden="true">
            <rect x={-1} y={-3} width={6} height={6} rx={1} stroke="#f1f5f9" strokeWidth={1.2} fill="none" />
            <rect x={-3} y={-1} width={6} height={6} rx={1} stroke="#f1f5f9" strokeWidth={1.2} fill="none" />
          </g>
        </g>
      )}
    </g>
  );
}

interface RoutePolylineProps {
  route: MapRoute;
  imageWidth: number;
  imageHeight: number;
  isDrawing: boolean;
  onRouteClick: (route: MapRoute) => void;
  onRouteContextMenu: (route: MapRoute, clientX: number, clientY: number) => void;
  onRouteHoverEnter: (route: MapRoute, clientX: number, clientY: number) => void;
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
  const shareTokenForBadge = useShareToken();

  let points: Array<{ x: number; y: number }> = [];
  try {
    points = JSON.parse(route.points) as Array<{ x: number; y: number }>;
  } catch {
    return null;
  }

  if (points.length < 2) return null;

  const svgPoints = points
    .map((p) => `${p.x * imageWidth},${p.y * imageHeight}`)
    .join(' ');

  const color = route.color ?? '#6b7280';

  const pointerEventsValue: React.CSSProperties['pointerEvents'] = isDrawing ? 'none' : 'auto';

  const handleClick = (e: React.MouseEvent) => {
    if (isDrawing) return;
    e.stopPropagation();
    onRouteClick(route);
  };

  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    onRouteContextMenu(route, e.clientX, e.clientY);
  };

  const handlePointerEnter = (e: React.PointerEvent) => {
    onRouteHoverEnter(route, e.clientX, e.clientY);
  };

  const handlePointerLeave = () => {
    onRouteHoverLeave();
  };

  const midIdx = Math.floor((points.length - 1) / 2);
  const p0 = points[midIdx];
  const p1 = points[midIdx + 1];
  const midX = ((p0.x + p1.x) / 2) * imageWidth;
  const midY = ((p0.y + p1.y) / 2) * imageHeight;

  const labelText =
    route.name.length > ROUTE_LABEL_MAX_CHARS
      ? route.name.slice(0, ROUTE_LABEL_MAX_CHARS) + '…'
      : route.name;

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
      {/* Solid chip matching the map chrome, with an accent-colour border. */}
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
  let points: Array<{ x: number; y: number }> = [];
  try {
    points = JSON.parse(region.points) as Array<{ x: number; y: number }>;
  } catch {
    return null;
  }

  if (points.length < 3) return null;

  const svgPoints = points
    .map((p) => `${p.x * imageWidth},${p.y * imageHeight}`)
    .join(' ');

  const handleClick = (e: React.MouseEvent<SVGPolygonElement>) => {
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
      fill={region.terrainTypeColor} // derived color — NOT region.color (D-43-04)
      fillOpacity={viewerOpacity} // per-viewer, 0..1
      stroke="none" // borderless (D-43-04)
      strokeWidth={0}
      style={{ cursor: 'default', pointerEvents: isDrawing ? 'none' : 'auto' }}
      onClick={handleClick}
      onContextMenu={handleContextMenu}
      role="none"
      aria-hidden="true"
    />
  );
}

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
  medallions,
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
  highlightedItemId = null,
  onOpenMap,
}, ref) {
  const svgRef = useRef<SVGSVGElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [currentScale, setCurrentScale] = useState(1);
  const zoomBehaviorRef = useRef<ZoomBehavior<SVGSVGElement, unknown> | null>(null);
  const [pointerImgPos, setPointerImgPos] = useState<{ x: number; y: number } | null>(null);
  const navigate = useNavigate();

  const [hoveredTooltip, setHoveredTooltip] = useState<{
    title: string;
    type: string | undefined;
    summary: string | undefined | null;
    clientX: number;
    clientY: number;
    entryId?: string | null;
    targetMapId?: string | null;
  } | null>(null);
  const hoverLeaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const shareToken = useShareToken();

  const isDrawing = addPinMode || drawRegionMode || drawRouteMode || paintTerrainMode;

  const isDrawingRef = useRef(isDrawing);
  useEffect(() => {
    isDrawingRef.current = isDrawing;
  }, [isDrawing]);

  useEffect(() => {
    return () => {
      if (hoverLeaveTimerRef.current !== null) {
        clearTimeout(hoverLeaveTimerRef.current);
      }
    };
  }, []);

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
      .filter((event) => {
        if (event.type === 'wheel') return true;
        if (isDrawingRef.current) return false;
        return !event.ctrlKey && !event.button;
      })
      .on('zoom', (evt) => {
        g.attr('transform', evt.transform.toString());
        setCurrentScale(evt.transform.k);
      });

    zoomBehaviorRef.current = zoomBehavior;

    svg.call(zoomBehavior);
    svg.on('dblclick.zoom', null);

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
    panZoomTo(nx: number, ny: number) {
      if (!svgRef.current || !zoomBehaviorRef.current) return;
      const svg = select(svgRef.current);
      const px = nx * imageWidth;
      const py = ny * imageHeight;
      zoomBehaviorRef.current.translateTo(svg, px, py);
      zoomBehaviorRef.current.scaleTo(svg, PAN_ZOOM_TARGET_SCALE);
    },
  }), [imageWidth, imageHeight]);

  const screenToImage = (clientX: number, clientY: number): { nx: number; ny: number } | null => {
    const svgEl = svgRef.current;
    if (!svgEl) return null;

    if (typeof svgEl.createSVGPoint !== 'function' || typeof svgEl.getScreenCTM !== 'function') {
      return null;
    }

    const pt = svgEl.createSVGPoint();
    pt.x = clientX;
    pt.y = clientY;

    const screenCTM = svgEl.getScreenCTM();
    if (!screenCTM) return null;
    const root = pt.matrixTransform(screenCTM.inverse());

    const [imgX, imgY] = zoomTransform(svgEl).invert([root.x, root.y]);

    const nx = clamp(imgX / imageWidth, 0, 1);
    const ny = clamp(imgY / imageHeight, 0, 1);
    return { nx, ny };
  };

  const handleSvgClick = (e: React.MouseEvent<SVGSVGElement>) => {
    if (!addPinMode && !drawRegionMode && !drawRouteMode && !paintTerrainMode) return;
    if ((e.target as Element).closest('g[aria-label]')) return;

    const pos = screenToImage(e.clientX, e.clientY);
    if (!pos) return;
    onCanvasClick(pos.nx, pos.ny);
  };

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

  const handleNavigate = (entryId: string) => {
    if (shareToken) {
      navigate(`/share/${shareToken}/entries/${entryId}`);
    } else {
      navigate(`/universes/${universeId}/entries/${entryId}`);
    }
  };

  const handlePinHoverEnter = useCallback((pin: MapPin, clientX: number, clientY: number) => {
    if (hoverLeaveTimerRef.current !== null) {
      clearTimeout(hoverLeaveTimerRef.current);
      hoverLeaveTimerRef.current = null;
    }
    const isMapOnly = !!pin.targetMapId && !pin.entryId;
    setHoveredTooltip({
      title: isMapOnly ? 'Opens map' : (pin.entryTitle ?? 'Pin'),
      type: isMapOnly ? undefined : pin.entryType,
      summary: isMapOnly ? undefined : pin.summary,
      clientX,
      clientY,
      entryId: pin.entryId,
      targetMapId: pin.targetMapId,
    });
  }, []);

  const handleRegionHoverEnter = useCallback((region: MapRegion, clientX: number, clientY: number) => {
    if (hoverLeaveTimerRef.current !== null) {
      clearTimeout(hoverLeaveTimerRef.current);
      hoverLeaveTimerRef.current = null;
    }
    setHoveredTooltip({
      title: region.name || 'Region',
      type: undefined,
      summary: undefined,
      clientX,
      clientY,
      entryId: region.entryId,
      targetMapId: region.targetMapId,
    });
  }, []);

  const handleRouteHoverEnter = useCallback((route: MapRoute, clientX: number, clientY: number) => {
    if (hoverLeaveTimerRef.current !== null) {
      clearTimeout(hoverLeaveTimerRef.current);
      hoverLeaveTimerRef.current = null;
    }
    setHoveredTooltip({
      title: route.name || 'Route',
      type: undefined,
      summary: undefined,
      clientX,
      clientY,
    });
  }, []);

  const handleHoverLeave = useCallback(() => {
    hoverLeaveTimerRef.current = setTimeout(() => {
      setHoveredTooltip(null);
      hoverLeaveTimerRef.current = null;
    }, 150);
  }, []);

  const pendingPoints = pendingVertices
    .map((p) => `${p.x * imageWidth},${p.y * imageHeight}`)
    .join(' ');

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

  const previewPoints =
    (drawRegionMode || drawRouteMode || paintTerrainMode) && pendingVertices.length > 0 && pointerImgPos
      ? pendingPoints + ` ${pointerImgPos.x},${pointerImgPos.y}`
      : pendingPoints;

  const previewColor = 'var(--color-accent, #3b82f6)';

  const tooltipStyle = hoveredTooltip ? (() => {
    const rect = containerRef.current?.getBoundingClientRect();
    const left = hoveredTooltip.clientX - (rect?.left ?? 0) + 14;
    const top = hoveredTooltip.clientY - (rect?.top ?? 0) + 14;
    return { left, top } as React.CSSProperties;
  })() : undefined;

  const hasExcerpt =
    hoveredTooltip?.summary != null &&
    hoveredTooltip.summary.trim().length > 0;

  const excerptText =
    hasExcerpt && hoveredTooltip!.summary!.length > 120
      ? hoveredTooltip!.summary!.slice(0, 120) + '…'
      : hoveredTooltip?.summary ?? '';

  const medallion: MedallionSource | undefined = hoveredTooltip?.entryId
    ? (medallions?.get(hoveredTooltip.entryId) ?? {
        title: hoveredTooltip.title,
        entryType: hoveredTooltip.type ?? 'concept',
        icon: null,
        coverThumbUrl: null,
      })
    : undefined;

  return (
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
      {/* Placed OUTSIDE <g.viewport> so they are not zoom-transformed. */}
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
              if (!layerViewerState[layer.id]?.visible) return null; // hidden layer → render nothing
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
              onOpenMap={onOpenMap}
            />
          ))}
        </g>

        {/* ── Phase 52 SEARCH-01: highlight pulse for search result selection (D-05a) ──
            Rendered ABOVE all items. React SVG only — no d3 datum handlers.
            CRITICAL: uses React-rendered SVG circles with SMIL <animate> elements.
            No d3 .on(event,(e,d)=>) (memory: timeline-pins-react-rendered-no-d3-datum).
            Pulse: expanding ring (r grows from 12 to 50) fading to 0 opacity over 1.5s.
            Position: image-space coords for pin/region/route (same centroid/midpoint logic
            as the lock badge renderers in PinCircle/RegionPolygon/RoutePolyline). */}
        {highlightedItemId && (() => {
          let px: number | null = null;
          let py: number | null = null;

          const hitPin = pins.find((p) => p.id === highlightedItemId);
          if (hitPin) {
            px = hitPin.x * imageWidth;
            py = hitPin.y * imageHeight;
          }

          if (px === null) {
            const hitRegion = regions.find((r) => r.id === highlightedItemId);
            if (hitRegion) {
              try {
                const pts = JSON.parse(hitRegion.points) as Array<{ x: number; y: number }>;
                if (pts.length > 0) {
                  px = (pts.reduce((s, p) => s + p.x, 0) / pts.length) * imageWidth;
                  py = (pts.reduce((s, p) => s + p.y, 0) / pts.length) * imageHeight;
                }
              } catch { /* malformed → skip */ }
            }
          }

          if (px === null) {
            const hitRoute = routes.find((r) => r.id === highlightedItemId);
            if (hitRoute) {
              try {
                const pts = JSON.parse(hitRoute.points) as Array<{ x: number; y: number }>;
                if (pts.length >= 2) {
                  const midIdx = Math.floor((pts.length - 1) / 2);
                  px = ((pts[midIdx].x + pts[midIdx + 1].x) / 2) * imageWidth;
                  py = ((pts[midIdx].y + pts[midIdx + 1].y) / 2) * imageHeight;
                } else if (pts.length === 1) {
                  px = pts[0].x * imageWidth;
                  py = pts[0].y * imageHeight;
                }
              } catch { /* malformed → skip */ }
            }
          }

          if (px === null || py === null) return null;

          return (
            <g
              className="highlight-pulse"
              style={{ pointerEvents: 'none' }}
              aria-hidden="true"
            >
              {/* Outer expanding ring — fades out as it grows */}
              <circle cx={px} cy={py} r={12} fill="none" stroke="var(--color-accent, #3b82f6)" strokeWidth={2 / currentScale} opacity={1}>
                <animate attributeName="r" from={12 / currentScale} to={50 / currentScale} dur="1.5s" fill="freeze" />
                <animate attributeName="opacity" from={0.9} to={0} dur="1.5s" fill="freeze" />
              </circle>
              {/* Inner solid dot — fades more slowly */}
              <circle cx={px} cy={py} r={6 / currentScale} fill="var(--color-accent, #3b82f6)" opacity={0.7}>
                <animate attributeName="opacity" from={0.7} to={0} dur="1.5s" fill="freeze" />
              </circle>
            </g>
          );
        })()}
      </g>
    </svg>

    {/* ── Hover tooltip overlay (D-07, D-08, Plan 04 Task 2) ── */}
    {/* pointer-events-none wrapper: d3-zoom and pin drag must NEVER be blocked (MapLegend 148 guard). */}
    {/* T-50-07: summary rendered as React text children — auto-escaped, NEVER dangerouslySetInnerHTML. */}
    <div className="pointer-events-none absolute inset-0">
      {hoveredTooltip && (
        <div
          data-testid="map-tooltip"
          className="pointer-events-none absolute z-50 max-w-[260px] rounded-md border border-line-strong bg-raised shadow-sm px-3 py-2"
          style={tooltipStyle}
        >
          {/* Identity row — Content-Forward Views §6. Regions and map-only pins have no
              entryId, so `medallion` is undefined for them and no disc renders (see above). */}
          <div className="flex items-center gap-2">
            {medallion && <Medallion {...medallion} size="sm" />}
            <div className="min-w-0">
              {/* Title — always shown (D-07, D-08) */}
              <p className="font-display text-sm font-semibold text-ink truncate">
                {hoveredTooltip.title}
              </p>
              {/* Entry type — shown when present (pin type; regions may not have it) */}
              {hoveredTooltip.type && <TypeBadge type={hoveredTooltip.type} />}
            </div>
          </div>
          {/* Summary excerpt — ONLY when summary is a non-empty string (D-08).
              Empty string / null / undefined → NO excerpt, NO placeholder. */}
          {hasExcerpt && (
            <p
              data-testid="tooltip-excerpt"
              className="mt-1 text-xs text-ink line-clamp-2"
            >
              {excerptText}
            </p>
          )}
          {/* Phase 53 NEST-01 (D-02): dual-target hint — shown ONLY when item has BOTH entryId and targetMapId.
              "Opens map" clarity line makes the click behavior unambiguous before offering the entry link.
              "View entry →" is the ONLY path to the entry for share visitors (no context menu in share).
              pointer-events-auto on the link so it is clickable despite the pointer-events-none wrapper.
              onPointerEnter cancels the hover-leave grace timer; onPointerLeave dismisses immediately. */}
          {hoveredTooltip.entryId && hoveredTooltip.targetMapId && (
            <>
              <p className="mt-1 text-xs text-ink-secondary">Opens map</p>
              <a
                data-testid="tooltip-view-entry"
                href="#"
                className="mt-0.5 block text-xs"
                style={{ pointerEvents: 'auto', color: 'var(--color-accent)' }}
                onPointerEnter={() => {
                  if (hoverLeaveTimerRef.current !== null) {
                    clearTimeout(hoverLeaveTimerRef.current);
                    hoverLeaveTimerRef.current = null;
                  }
                }}
                onPointerLeave={() => {
                  setHoveredTooltip(null);
                }}
                onClick={(e) => {
                  e.preventDefault();
                  if (hoveredTooltip.entryId) handleNavigate(hoveredTooltip.entryId);
                }}
              >
                View entry →
              </a>
            </>
          )}
        </div>
      )}
    </div>
    </div>
  );
});
