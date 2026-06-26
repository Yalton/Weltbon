/**
 * MapCanvas regression tests — UAT Test 5 click-through bug (43-05).
 *
 * This file exists specifically to cover the UAT Test 5 click-through bug that the mocked
 * MapEditor test (web/src/views/MapEditor.test.tsx) cannot catch: MapEditor.test.tsx mocks
 * MapCanvas entirely (renders a stub), so it cannot catch a bug in MapCanvas's own pointer-
 * event routing.
 *
 * Root cause (closed by Task 1): TerrainAreaPolygon and RegionPolygon both set
 * pointerEvents:'auto' and call e.stopPropagation() unconditionally, so a click over
 * an existing terrain area or political region is swallowed — the click never reaches the
 * root <svg> onClick (handleSvgClick), which is the only path to onCanvasClick.
 *
 * Why we assert structure (pointerEvents), not the full click→onCanvasClick chain:
 * The real chain is:
 *   fireEvent.click → root <svg> onClick (handleSvgClick) → screenToImage()
 *   → svgEl.createSVGPoint()/getScreenCTM() → BOTH return null/undefined in jsdom 25
 *   → handleSvgClick early-returns at `if (!pos) return;` → onCanvasClick is never reached.
 * Asserting onCanvasClick would therefore be permanently RED in jsdom regardless of the fix.
 * Stubbing the SVG geometry pipeline (createSVGPoint + getScreenCTM + DOMMatrix) would only
 * re-test a hand-rolled copy of the coordinate math, not the actual bug.
 * The structural assertion (polygon.style.pointerEvents === 'none') directly captures the
 * root cause — the overlay polygon's pointer-events value. Tests A/B flip RED if Task 1's
 * fix is reverted, making this a true regression guard.
 *
 * Test A: TerrainAreaPolygon has pointerEvents:'none' when paintTerrainMode=true.
 * Test B: RegionPolygon has pointerEvents:'none' and does NOT call onRegionClick when
 *         drawRegionMode=true.
 * Test C: RegionPolygon has pointerEvents:'auto' and DOES call onRegionClick exactly once
 *         when all modes are false (idle no-regression guard).
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import React from 'react';
import { render, fireEvent, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MapCanvas } from './MapCanvas';
import type { TerrainAreaRegion, MapRegion, MapPin } from '../hooks/useMap';
import type { MapLayer } from '../hooks/useMapLayers';

// Mock ShareModeContext — MapCanvas imports useShareToken; not under test here.
// Use plain arrow functions (not vi.fn()) so clearAllMocks does not wipe the returns.
vi.mock('../contexts/ShareModeContext', () => ({
  useShareMode: () => false,
  useShareToken: () => null,
  ShareModeContext: {},
  ShareModeProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

// ── Fixtures ──────────────────────────────────────────────────────────────────
const IMAGE_URL = '/x.png';
const IMAGE_WIDTH = 1000;
const IMAGE_HEIGHT = 1000;
const CREATED_AT = '2026-01-01T00:00:00.000Z';

// A square polygon covering the center 10-90% of the image.
const SQUARE_POINTS = JSON.stringify([
  { x: 0.1, y: 0.1 },
  { x: 0.9, y: 0.1 },
  { x: 0.9, y: 0.9 },
  { x: 0.1, y: 0.9 },
]);

const TERRAIN_AREA: TerrainAreaRegion = {
  id: 'ta1',
  mapId: 'm1',
  entryId: null,
  name: 'Forest',
  points: SQUARE_POINTS,
  color: null,
  createdAt: CREATED_AT,
  terrainTypeId: 'tt1',
  terrainTypeColor: '#228b22',
  layerId: 'L1',
  layerSortOrder: 0,
};

const LAYER: MapLayer = {
  id: 'L1',
  universeId: 'u1',
  name: 'Biomes',
  ordered: false,
  defaultOpacity: 0.6,
  sortOrder: 0,
  createdAt: CREATED_AT,
};

const POLITICAL_REGION: MapRegion = {
  id: 'r1',
  mapId: 'm1',
  entryId: 'e1',
  name: 'Realm',
  points: SQUARE_POINTS,
  color: '#6b7280',
  createdAt: CREATED_AT,
  terrainTypeId: null,
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeQC() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

type ExtraProps = Partial<React.ComponentProps<typeof MapCanvas>>;

function renderMapCanvas(props: ExtraProps = {}) {
  const qc = makeQC();
  const onCanvasClick = vi.fn();
  const onRegionClick = vi.fn();
  const result = render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <MapCanvas
          imageUrl={IMAGE_URL}
          imageWidth={IMAGE_WIDTH}
          imageHeight={IMAGE_HEIGHT}
          pins={[]}
          regions={[]}
          addPinMode={false}
          drawRegionMode={false}
          pendingVertices={[]}
          selectedPinId={null}
          universeId="u1"
          onCanvasClick={onCanvasClick}
          onPinDragEnd={vi.fn()}
          onPinContextMenu={vi.fn()}
          onRegionClick={onRegionClick}
          onRegionContextMenu={vi.fn()}
          terrainAreas={[]}
          layers={[]}
          layerViewerState={{}}
          paintTerrainMode={false}
          onTerrainAreaContextMenu={vi.fn()}
          {...props}
        />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { ...result, onCanvasClick, onRegionClick };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('MapCanvas — overlay polygon pointer-events gating (UAT Test 5, 43-05)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  /**
   * Test A — terrain area transparent during paint mode.
   * Render MapCanvas with paintTerrainMode=true and one visible TerrainAreaRegion.
   * The terrain <polygon> must report pointerEvents:'none' so clicks fall through to
   * handleSvgClick (the only path to onCanvasClick).
   *
   * RED pre-fix: current literal 'auto' → 'none' !== 'auto' → FAIL.
   * GREEN post-fix: isDrawing=true → pointerEvents:'none' → PASS.
   */
  it('Test A: terrain polygon has pointerEvents:none when paintTerrainMode=true', () => {
    const { container } = renderMapCanvas({
      paintTerrainMode: true,
      terrainAreas: [TERRAIN_AREA],
      layers: [LAYER],
      layerViewerState: { L1: { visible: true, opacity: 0.6 } },
    });

    const polygon = container.querySelector('.terrain-areas polygon');
    expect(polygon).not.toBeNull();
    expect((polygon as HTMLElement).style.pointerEvents).toBe('none');
  });

  /**
   * Test B — region polygon transparent during draw mode; no onRegionClick navigation.
   * Render MapCanvas with drawRegionMode=true and one political MapRegion.
   * Assert pointerEvents:'none' AND that clicking the polygon does NOT call onRegionClick
   * (the handleClick early-return while isDrawing prevents both stopPropagation and navigation).
   *
   * RED pre-fix (before Task 1): pointerEvents:'auto' and handleClick calls onRegionClick → FAIL.
   * GREEN post-fix: pointerEvents:'none' and onRegionClick not called → PASS.
   */
  it('Test B: region polygon has pointerEvents:none and does not navigate when drawRegionMode=true', () => {
    const { container, onRegionClick } = renderMapCanvas({
      drawRegionMode: true,
      regions: [POLITICAL_REGION],
    });

    const polygon = container.querySelector('.regions polygon');
    expect(polygon).not.toBeNull();
    expect((polygon as HTMLElement).style.pointerEvents).toBe('none');

    // Fire a click — onRegionClick must NOT be called while drawing.
    fireEvent.click(polygon!);
    expect(onRegionClick).not.toHaveBeenCalled();
  });

  /**
   * Test C — idle no-regression: region polygon is clickable and navigates when no mode armed.
   * Render MapCanvas with all modes false. The region polygon must have pointerEvents:'auto'
   * and a click must call onRegionClick exactly once (idle navigation still works).
   *
   * This test passes BOTH before and after the fix; it guards against over-gating.
   */
  it('Test C: idle region polygon has pointerEvents:auto and click navigates (onRegionClick called)', () => {
    const { container, onRegionClick } = renderMapCanvas({
      regions: [POLITICAL_REGION],
    });

    const polygon = container.querySelector('.regions polygon');
    expect(polygon).not.toBeNull();
    expect((polygon as HTMLElement).style.pointerEvents).toBe('auto');

    fireEvent.click(polygon!);
    expect(onRegionClick).toHaveBeenCalledTimes(1);
    expect(onRegionClick).toHaveBeenCalledWith(POLITICAL_REGION);
  });
});

// ── Phase 50 Task 1 (Plan 02): grid overlay + imperative zoom handle ──────────

describe('MapCanvas — grid overlay (D-05, Plan 02 Task 1)', () => {
  /**
   * Test I: grid overlay is ABSENT when gridVisible is false (default).
   */
  it('Test I: grid-overlay group is absent when gridVisible=false', () => {
    const { container } = renderMapCanvas({ gridVisible: false });
    const grid = container.querySelector('.grid-overlay');
    expect(grid).toBeNull();
  });

  /**
   * Test J: grid overlay is PRESENT when gridVisible=true and uses pointerEvents:'none'.
   */
  it('Test J: grid-overlay group renders with pointerEvents:none when gridVisible=true', () => {
    const { container } = renderMapCanvas({ gridVisible: true });
    const grid = container.querySelector('.grid-overlay');
    expect(grid, 'grid-overlay <g> must exist when gridVisible=true').not.toBeNull();
    expect((grid as HTMLElement).style.pointerEvents).toBe('none');
  });

  /**
   * Test K: grid overlay is absent when gridVisible is undefined (default off).
   */
  it('Test K: grid-overlay is absent when gridVisible prop is omitted', () => {
    const { container } = renderMapCanvas({});
    const grid = container.querySelector('.grid-overlay');
    expect(grid).toBeNull();
  });
});

// ── Phase 50 Task 2: PinCircle teardrop + glow + drag regression ─────────────

// A minimal pin fixture for teardrop and drag tests.
const TEST_PIN: MapPin = {
  id: 'pin1',
  mapId: 'm1',
  entryId: 'entry1',
  x: 0.5,
  y: 0.5,
  color: '#3b82f6',
  icon: null,
  entryTitle: 'Camp Fire',
  entryType: 'location',
};

// Pin with no color / icon — graceful degradation test.
const BARE_PIN: MapPin = {
  id: 'pin2',
  mapId: 'm1',
  entryId: 'entry2',
  x: 0.3,
  y: 0.3,
  color: null,
  icon: null,
  entryTitle: 'Unknown',
  entryType: undefined,
};

/**
 * Attach stub setPointerCapture / releasePointerCapture to an element.
 * Required because SVG <g> elements in jsdom do not have these methods and
 * PinCircle's pointer handlers call them unconditionally.
 */
function stubPointerCapture(el: Element) {
  Object.defineProperty(el, 'setPointerCapture', {
    value: vi.fn(),
    configurable: true,
    writable: true,
  });
  Object.defineProperty(el, 'releasePointerCapture', {
    value: vi.fn(),
    configurable: true,
    writable: true,
  });
}

describe('PinCircle — teardrop render (D-03, Task 2)', () => {
  /**
   * Test D: The pin group must contain a <path> element (teardrop shape).
   * RED pre-impl: PinCircle renders a <circle r=14>, not a <path> → FAIL.
   * GREEN post-impl: teardrop <path> replaces the visible circle → PASS.
   */
  it('Test D: pin group contains a teardrop <path> (not just circles)', () => {
    const { container } = renderMapCanvas({ pins: [TEST_PIN] });
    const pinGroup = container.querySelector('.pins g[aria-label]');
    expect(pinGroup).not.toBeNull();
    // The teardrop must be a <path> inside the pin group.
    const tearpath = pinGroup!.querySelector('path');
    expect(tearpath, 'PinCircle should render a teardrop <path>').not.toBeNull();
  });

  /**
   * Test E: A drop-shadow SVG filter (feDropShadow) must be defined in the canvas.
   * RED pre-impl: no <feDropShadow> in the DOM → FAIL.
   * GREEN post-impl: <defs> contains <feDropShadow> → PASS.
   */
  it('Test E: SVG <defs> defines a feDropShadow filter', () => {
    const { container } = renderMapCanvas({ pins: [TEST_PIN] });
    const dropShadow = container.querySelector('feDropShadow');
    expect(dropShadow, 'MapCanvas <defs> must include a feDropShadow element').not.toBeNull();
  });

  /**
   * Test F: A pin with color=null and icon=null still renders a teardrop.
   * Graceful degradation (D-03): entryTypeHexColor fallback is used.
   * RED pre-impl: circle, not path → FAIL.
   * GREEN post-impl: teardrop <path> with fallback fill → PASS.
   */
  it('Test F: pin with color=null and icon=null still renders a teardrop', () => {
    const { container } = renderMapCanvas({ pins: [BARE_PIN] });
    const pinGroup = container.querySelector('.pins g[aria-label]');
    expect(pinGroup).not.toBeNull();
    const tearpath = pinGroup!.querySelector('path');
    expect(tearpath, 'Bare pin (no color, no icon) must still render a teardrop <path>').not.toBeNull();
  });
});

describe('PinCircle — drag regression (D-11, Task 2)', () => {
  /**
   * Test G: drag > threshold at currentScale=1 fires onDragEnd with correct DELTA coords.
   *
   * Why currentScale=1: jsdom cannot run d3-zoom layout, so currentScale stays at its
   * initial useState(1) value. The test still exercises the full drag path and the DELTA
   * formula (dxImg = dx / k / imageWidth). The scale-awareness is validated by the
   * formula structure, not a live zoom change.
   *
   * At scale=1, imageWidth=1000, imageHeight=1000, pin at (0.5, 0.5):
   *   drag from (200, 200) → (250, 215): dx=50, dy=15 (> threshold of 4)
   *   nx = clamp(0.5 + 50/(1*1000), 0, 1) = 0.55
   *   ny = clamp(0.5 + 15/(1*1000), 0, 1) = 0.515
   *
   * RED pre-impl: might pass if drag math unchanged, but feDropShadow test (E) is RED.
   * This test documents the expected contract and guards against future regressions.
   */
  it('Test G: drag > threshold calls onPinDragEnd with DELTA-converted coords', () => {
    const onPinDragEnd = vi.fn();
    const { container } = renderMapCanvas({
      pins: [TEST_PIN],
      onPinDragEnd,
    });

    const pinGroup = container.querySelector('.pins g[aria-label]') as Element;
    expect(pinGroup).not.toBeNull();
    stubPointerCapture(pinGroup);

    // Simulate: pointerdown → pointermove (> threshold) → pointerup
    fireEvent.pointerDown(pinGroup, { pointerId: 1, clientX: 200, clientY: 200, bubbles: true });
    fireEvent.pointerMove(pinGroup, { pointerId: 1, clientX: 250, clientY: 215, bubbles: true });
    fireEvent.pointerUp(pinGroup,   { pointerId: 1, clientX: 250, clientY: 215, bubbles: true });

    expect(onPinDragEnd).toHaveBeenCalledTimes(1);
    const [id, nx, ny] = onPinDragEnd.mock.calls[0] as [string, number, number];
    expect(id).toBe('pin1');
    // nx = clamp(0.5 + 50/(1*1000), 0, 1)
    expect(nx).toBeCloseTo(0.55, 4);
    // ny = clamp(0.5 + 15/(1*1000), 0, 1)
    expect(ny).toBeCloseTo(0.515, 4);
  });

  /**
   * Test H: drag BELOW threshold (< DRAG_THRESHOLD_PX=4) is treated as a click →
   * onPinDragEnd is NOT called.
   *
   * RED pre-impl: same — if drag math is unchanged this might already pass.
   * This test guards the threshold boundary: a tiny move must not trigger onDragEnd.
   */
  it('Test H: drag below threshold does not call onPinDragEnd', () => {
    const onPinDragEnd = vi.fn();
    const { container } = renderMapCanvas({
      pins: [TEST_PIN],
      onPinDragEnd,
    });

    const pinGroup = container.querySelector('.pins g[aria-label]') as Element;
    expect(pinGroup).not.toBeNull();
    stubPointerCapture(pinGroup);

    // Move only 2px — below DRAG_THRESHOLD_PX=4
    fireEvent.pointerDown(pinGroup, { pointerId: 1, clientX: 200, clientY: 200, bubbles: true });
    fireEvent.pointerMove(pinGroup, { pointerId: 1, clientX: 202, clientY: 201, bubbles: true });
    fireEvent.pointerUp(pinGroup,   { pointerId: 1, clientX: 202, clientY: 201, bubbles: true });

    expect(onPinDragEnd).not.toHaveBeenCalled();
  });
});

// ── Phase 50 Task 2 (Plan 04): pin/region hover tooltip (D-07, D-08) ──────────

// Tooltip pin fixtures — include summary field (MapPin.summary is optional per Plan 03).
const PIN_WITH_SUMMARY: MapPin = {
  id: 'tip1',
  mapId: 'm1',
  entryId: 'e_tip1',
  x: 0.5,
  y: 0.5,
  color: '#ff0000',
  icon: null,
  entryTitle: 'Dragon Keep',
  entryType: 'location',
  summary: 'An ancient fortress in the mountains.',
};

const PIN_EMPTY_SUMMARY: MapPin = {
  id: 'tip2',
  mapId: 'm1',
  entryId: 'e_tip2',
  x: 0.4,
  y: 0.4,
  color: '#0000ff',
  icon: null,
  entryTitle: 'Silent Town',
  entryType: 'location',
  summary: '',
};

const PIN_NULL_SUMMARY: MapPin = {
  id: 'tip3',
  mapId: 'm1',
  entryId: 'e_tip3',
  x: 0.6,
  y: 0.6,
  color: '#00ff00',
  icon: null,
  entryTitle: 'Hidden Cove',
  entryType: 'location',
  summary: null,
};

const REGION_FOR_HOVER: MapRegion = {
  id: 'r_hover',
  mapId: 'm1',
  entryId: 'e_region1',
  name: 'Northern Realm',
  points: SQUARE_POINTS,
  color: '#6b7280',
  createdAt: CREATED_AT,
  terrainTypeId: null,
};

describe('MapCanvas — pin/region hover tooltip (D-07, D-08, Plan 04 Task 2)', () => {
  /**
   * Test L: Hovering a pin shows a tooltip overlay with the pin title.
   * RED pre-impl: no tooltip overlay exists → FAIL.
   * GREEN post-impl: onPointerEnter sets hover state → tooltip renders → PASS.
   */
  it('Test L: hovering a pin shows a tooltip overlay with pin title', () => {
    const { container } = renderMapCanvas({ pins: [PIN_WITH_SUMMARY] });
    const pinGroup = container.querySelector('.pins g[aria-label]');
    expect(pinGroup).not.toBeNull();

    // Before hover: no tooltip overlay
    expect(container.querySelector('[data-testid="map-tooltip"]')).toBeNull();

    // Fire pointer enter on the pin group
    fireEvent.pointerEnter(pinGroup!);

    // After hover: tooltip overlay appears with the pin title
    const tooltip = container.querySelector('[data-testid="map-tooltip"]');
    expect(tooltip, 'tooltip overlay must appear on pointerEnter').not.toBeNull();
    expect(tooltip!.textContent).toContain('Dragon Keep');
  });

  /**
   * Test M: Hovering a pin with non-empty summary shows an excerpt line (D-07).
   * RED pre-impl: no tooltip → FAIL.
   * GREEN post-impl: summary is non-empty → excerpt rendered → PASS.
   */
  it('Test M: hovering a pin with non-empty summary shows an excerpt line (D-07)', () => {
    const { container } = renderMapCanvas({ pins: [PIN_WITH_SUMMARY] });
    const pinGroup = container.querySelector('.pins g[aria-label]');
    expect(pinGroup).not.toBeNull();

    fireEvent.pointerEnter(pinGroup!);

    const tooltip = container.querySelector('[data-testid="map-tooltip"]');
    expect(tooltip).not.toBeNull();
    // tooltip must contain an excerpt element (data-testid="tooltip-excerpt")
    const excerpt = tooltip!.querySelector('[data-testid="tooltip-excerpt"]');
    expect(excerpt, 'excerpt element must render when summary is non-empty').not.toBeNull();
    // excerpt must contain the summary text (or a truncation of it)
    expect(excerpt!.textContent).toContain('An ancient fortress');
  });

  /**
   * Test N: Hovering a pin with empty/null summary shows title + type only — no excerpt (D-08).
   * RED pre-impl: no tooltip → FAIL.
   * GREEN post-impl: summary is '' → no excerpt element → PASS.
   */
  it('Test N: hovering a pin with empty summary shows title only, no excerpt, no placeholder (D-08)', () => {
    const { container } = renderMapCanvas({ pins: [PIN_EMPTY_SUMMARY] });
    const pinGroup = container.querySelector('.pins g[aria-label]');
    expect(pinGroup).not.toBeNull();

    fireEvent.pointerEnter(pinGroup!);

    const tooltip = container.querySelector('[data-testid="map-tooltip"]');
    expect(tooltip).not.toBeNull();
    // Title must appear
    expect(tooltip!.textContent).toContain('Silent Town');
    // No excerpt element — D-08: empty summary → name+type only, no placeholder
    const excerpt = tooltip!.querySelector('[data-testid="tooltip-excerpt"]');
    expect(excerpt, 'no excerpt element when summary is empty string').toBeNull();
  });

  /**
   * Test N2: Hovering a pin with null summary also shows no excerpt (D-08).
   */
  it('Test N2: hovering a pin with null summary shows no excerpt (D-08)', () => {
    const { container } = renderMapCanvas({ pins: [PIN_NULL_SUMMARY] });
    const pinGroup = container.querySelector('.pins g[aria-label]');
    expect(pinGroup).not.toBeNull();

    fireEvent.pointerEnter(pinGroup!);

    const tooltip = container.querySelector('[data-testid="map-tooltip"]');
    expect(tooltip).not.toBeNull();
    expect(tooltip!.textContent).toContain('Hidden Cove');
    const excerpt = tooltip!.querySelector('[data-testid="tooltip-excerpt"]');
    expect(excerpt, 'no excerpt element when summary is null').toBeNull();
  });

  /**
   * Test O: Hovering a region shows the region name in the tooltip overlay.
   * RED pre-impl: no tooltip → FAIL.
   * GREEN post-impl: region onPointerEnter fires → region name in tooltip → PASS.
   */
  it('Test O: hovering a region shows the region name in the tooltip', () => {
    const { container } = renderMapCanvas({ regions: [REGION_FOR_HOVER] });
    const polygon = container.querySelector('.regions polygon');
    expect(polygon).not.toBeNull();

    fireEvent.pointerEnter(polygon!);

    const tooltip = container.querySelector('[data-testid="map-tooltip"]');
    expect(tooltip, 'tooltip overlay must appear on region pointerEnter').not.toBeNull();
    expect(tooltip!.textContent).toContain('Northern Realm');
  });

  /**
   * Test P: Entering a pin during an active drag does NOT call onDragEnd an extra time.
   * onPointerEnter must be independent of the drag ref — entering/leaving during drag
   * does not fire onDragEnd or reset the drag (Plan 01 D-11 isolation).
   *
   * RED pre-impl: no enter handler → no interference → could pass pre-impl, but the
   * tooltip test (L) ensures this describe block is MIXED-RED (L fails).
   * GREEN post-impl: hover handler reads dragging.current and returns early → onDragEnd
   * called exactly once (from the real pointerUp), not from enter/leave.
   */
  it('Test P: drag is unaffected by pointer enter/leave during an active drag', () => {
    const onPinDragEnd = vi.fn();
    const { container } = renderMapCanvas({
      pins: [PIN_WITH_SUMMARY],
      onPinDragEnd,
    });

    const pinGroup = container.querySelector('.pins g[aria-label]') as Element;
    expect(pinGroup).not.toBeNull();
    stubPointerCapture(pinGroup);

    // Start drag
    fireEvent.pointerDown(pinGroup, { pointerId: 1, clientX: 200, clientY: 200, bubbles: true });
    // Simulate enter/leave events during drag — must not trigger onDragEnd
    fireEvent.pointerEnter(pinGroup, { bubbles: true });
    fireEvent.pointerLeave(pinGroup, { bubbles: true });
    // Move enough to cross threshold (> 4px)
    fireEvent.pointerMove(pinGroup, { pointerId: 1, clientX: 250, clientY: 250, bubbles: true });
    fireEvent.pointerEnter(pinGroup, { bubbles: true });
    // End drag
    fireEvent.pointerUp(pinGroup, { pointerId: 1, clientX: 250, clientY: 250, bubbles: true });

    // onDragEnd called exactly once from pointerUp; enter/leave did NOT call it
    expect(onPinDragEnd).toHaveBeenCalledTimes(1);
    const [id] = onPinDragEnd.mock.calls[0] as [string, number, number];
    expect(id).toBe('tip1');
  });
});
