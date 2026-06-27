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
import type { TerrainAreaRegion, MapRegion, MapPin, MapRoute } from '../hooks/useMap';
import type { MapLayer } from '../hooks/useMapLayers';

// Mock ShareModeContext — MapCanvas imports useShareToken; not under test here.
// Use plain arrow functions (not vi.fn()) so clearAllMocks does not wipe the returns.
vi.mock('../contexts/ShareModeContext', () => ({
  useShareMode: () => false,
  useShareToken: () => null,
  ShareModeContext: {},
  ShareModeProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

// Mock useNavigate from react-router-dom — needed for BUG-B tests (51-07) to spy on navigation.
// Spreads actual module so MemoryRouter, Routes, etc. remain real (functional routing context).
// mockNavigate is reset by vi.clearAllMocks() in the global afterEach.
const mockNavigate = vi.fn();
vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router-dom')>();
  return { ...actual, useNavigate: () => mockNavigate };
});

// Mock d3-zoom to capture the filter function passed to zoom().filter(fn).
// Only the filter setter is intercepted; all other behavior (scaleExtent, on, etc.)
// delegates to the real implementation so existing tests are unaffected.
// Used by BUG-A tests (51-07) to directly assert filter logic without triggering
// d3's SVG geometry accessors (which crash in jsdom: svg.width.baseVal is undefined).
const capturedZoomFilter = {
  fn: null as ((event: { type: string; ctrlKey?: boolean; button?: number }) => boolean) | null,
};
vi.mock('d3-zoom', async (importOriginal) => {
  const actual = await importOriginal<typeof import('d3-zoom')>();
  return {
    ...actual,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    zoom: () => {
      // Call the real zoom() to get a fully-functional behavior object.
      const behavior = (actual.zoom as () => { filter: (...args: unknown[]) => typeof behavior })();
      const origFilter = behavior.filter.bind(behavior);
      // Wrap filter() to capture the fn argument and still call the original.
      behavior.filter = (...args: unknown[]) => {
        if (typeof args[0] === 'function') {
          capturedZoomFilter.fn = args[0] as typeof capturedZoomFilter.fn;
        }
        return origFilter(...args);
      };
      return behavior;
    },
  };
});

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

// ── Phase 51 Plan 06: RoutePolyline render tests ──────────────────────────────

// A simple two-vertex route going from (0.2, 0.5) to (0.8, 0.5) — a horizontal line.
const ROUTE_POINTS = JSON.stringify([
  { x: 0.2, y: 0.5 },
  { x: 0.8, y: 0.5 },
]);

const SOLID_ROUTE: MapRoute = {
  id: 'route1',
  mapId: 'm1',
  entryId: 'e1',
  name: '',
  points: ROUTE_POINTS,
  color: '#ef4444',
  lineStyle: 'solid',
  width: 4,
  showArrow: false,
  createdAt: CREATED_AT,
};

const DASHED_ROUTE: MapRoute = {
  id: 'route2',
  mapId: 'm1',
  entryId: null,
  name: '',
  points: ROUTE_POINTS,
  color: '#3b82f6',
  lineStyle: 'dashed',
  width: 2,
  showArrow: false,
  createdAt: CREATED_AT,
};

const NAMED_ROUTE: MapRoute = {
  id: 'route3',
  mapId: 'm1',
  entryId: null,
  name: 'The High Road',
  points: ROUTE_POINTS,
  color: '#a855f7',
  lineStyle: 'solid',
  width: 4,
  showArrow: false,
  createdAt: CREATED_AT,
};

const ARROW_ROUTE: MapRoute = {
  id: 'route4',
  mapId: 'm1',
  entryId: null,
  name: '',
  points: ROUTE_POINTS,
  color: '#f97316',
  lineStyle: 'solid',
  width: 4,
  showArrow: true,
  createdAt: CREATED_AT,
};

describe('MapCanvas — RoutePolyline render (Phase 51, Plan 06)', () => {
  /**
   * Test Q: A solid route renders two stacked <polyline> elements (visible + hit-stroke)
   * with fill="none" and the expected stroke color on the visible path.
   *
   * The hit-stroke polyline carries stroke="transparent" so it does not visually obscure
   * the route, and the visible polyline has pointerEvents:'none'.
   */
  it('Test Q: solid route renders open polyline (not polygon) with fill="none" and correct stroke color', () => {
    const { container } = renderMapCanvas({ routes: [SOLID_ROUTE] });

    // The routes <g> must exist.
    const routesG = container.querySelector('.routes');
    expect(routesG, '.routes group must exist').not.toBeNull();

    // There must be at least one <polyline> inside the routes group (not a <polygon>).
    const polylines = routesG!.querySelectorAll('polyline');
    expect(polylines.length, 'routes group must contain polyline elements').toBeGreaterThanOrEqual(1);

    // The polygon element must NOT appear (open geometry, not closed).
    const polygon = routesG!.querySelector('polygon');
    expect(polygon, 'route must not render a <polygon> — open geometry only').toBeNull();

    // The visible polyline should have fill="none" and the route color as stroke.
    // The visible polyline has pointerEvents:'none' and no onClick.
    const visiblePolyline = Array.from(polylines).find(
      (el) => (el as SVGPolylineElement).getAttribute('stroke') === SOLID_ROUTE.color,
    );
    expect(visiblePolyline, 'a polyline with the route color must exist').not.toBeNull();
    expect((visiblePolyline as SVGPolylineElement).getAttribute('fill')).toBe('none');
    expect((visiblePolyline as SVGPolylineElement).style.pointerEvents).toBe('none');
  });

  /**
   * Test R: A dashed route sets strokeDasharray on the visible polyline.
   * The hit-stroke polyline does NOT have strokeDasharray (it is transparent and uses
   * a solid wide stroke for maximum hit area coverage).
   */
  it('Test R: dashed route sets strokeDasharray on the visible polyline', () => {
    const { container } = renderMapCanvas({ routes: [DASHED_ROUTE] });

    const routesG = container.querySelector('.routes');
    expect(routesG).not.toBeNull();

    const polylines = routesG!.querySelectorAll('polyline');
    // The visible polyline (stroke=route color) must have a strokeDasharray attribute.
    const visiblePolyline = Array.from(polylines).find(
      (el) => (el as SVGPolylineElement).getAttribute('stroke') === DASHED_ROUTE.color,
    );
    expect(visiblePolyline, 'dashed route must have a colored visible polyline').not.toBeNull();
    const dashArray = (visiblePolyline as SVGPolylineElement).getAttribute('stroke-dasharray');
    expect(dashArray, 'dashed route visible polyline must have strokeDasharray set').not.toBeNull();
    expect(dashArray).not.toBe('');
  });

  /**
   * Test S: A named route renders its label text inside a foreignObject chip.
   * The chip appears at the path midpoint and displays the route name.
   */
  it('Test S: named route renders its label chip text in a foreignObject', () => {
    const { container } = renderMapCanvas({ routes: [NAMED_ROUTE] });

    const routesG = container.querySelector('.routes');
    expect(routesG).not.toBeNull();

    // The <foreignObject> must be present.
    const fo = routesG!.querySelector('foreignObject');
    expect(fo, 'named route must render a <foreignObject> label chip').not.toBeNull();

    // The label chip must contain the route name text.
    expect(fo!.textContent).toContain(NAMED_ROUTE.name);
  });

  /**
   * Test T: A route with showArrow=true renders an SVG <marker> (arrowhead) and
   * the visible polyline references it via markerEnd.
   */
  it('Test T: showArrow route renders an SVG <marker> arrowhead referenced on the polyline', () => {
    const { container } = renderMapCanvas({ routes: [ARROW_ROUTE] });

    const routesG = container.querySelector('.routes');
    expect(routesG).not.toBeNull();

    // A <marker> element must be defined in <defs> inside the route group.
    const marker = routesG!.querySelector('marker');
    expect(marker, 'showArrow route must define a <marker> arrowhead').not.toBeNull();

    // The visible polyline must carry a markerEnd/marker-end reference.
    const polylines = routesG!.querySelectorAll('polyline');
    const arrowPolyline = Array.from(polylines).find(
      (el) => (el as SVGPolylineElement).getAttribute('marker-end') !== null,
    );
    expect(arrowPolyline, 'a polyline must reference the arrowhead via marker-end').not.toBeNull();
  });

  /**
   * Test U: The routes <g> appears before (i.e., earlier in DOM order than) the pins <g>,
   * so routes are rendered beneath pins (D-08 stacking).
   */
  it('Test U: routes <g> is ordered before pins <g> in the DOM (routes beneath pins)', () => {
    const { container } = renderMapCanvas({
      routes: [SOLID_ROUTE],
      pins: [TEST_PIN],
    });

    const allGroups = Array.from(container.querySelectorAll('g[class]'));
    const routesIdx = allGroups.findIndex((g) => g.classList.contains('routes'));
    const pinsIdx = allGroups.findIndex((g) => g.classList.contains('pins'));

    expect(routesIdx, 'routes <g> must be found in DOM').toBeGreaterThanOrEqual(0);
    expect(pinsIdx, 'pins <g> must be found in DOM').toBeGreaterThanOrEqual(0);
    expect(routesIdx, 'routes <g> must appear before pins <g> in DOM order (beneath pins)').toBeLessThan(pinsIdx);
  });
});

// ── Phase 51 Plan 07 BUG-1 regression: route draw preview is an open polyline ──
//
// Confirms the fix for "Route draws as a CLOSED POLYGON": when drawRouteMode is true
// and pendingVertices are present, the rubber-band preview must render a <polyline>
// (open geometry, fill="none") — NOT a <polygon> (which auto-closes and fills).
//
// Also confirms the first-vertex circle aria-label is "Vertex 1" in route mode
// (NOT "Close polygon", which would imply snap-to-close is active — it must not be).
describe('MapCanvas — route draw preview is an open polyline (BUG-1 fix, Plan 07)', () => {
  const TWO_VERTS = [
    { x: 0.2, y: 0.3 },
    { x: 0.6, y: 0.7 },
  ];

  /**
   * Test V: drawRouteMode + pending vertices → preview group renders a <polyline>
   * with fill="none" and NO <polygon>.
   *
   * If this test turns RED after a refactor, it means the route preview was switched
   * back to a closed <polygon> — a direct regression of BUG-1.
   */
  it('Test V: drawRouteMode preview renders <polyline fill="none"> not <polygon>', () => {
    const { container } = renderMapCanvas({
      drawRouteMode: true,
      pendingVertices: TWO_VERTS,
    });

    const previewG = container.querySelector('.region-preview');
    expect(previewG, '.region-preview group must exist when drawRouteMode + vertices').not.toBeNull();

    // Must contain a <polyline> (open geometry).
    const polyline = previewG!.querySelector('polyline');
    expect(polyline, 'route preview must render a <polyline> (open path)').not.toBeNull();
    expect(polyline!.getAttribute('fill')).toBe('none');

    // Must NOT contain a <polygon> (closed, auto-fills — wrong for a route).
    const polygon = previewG!.querySelector('polygon');
    expect(polygon, 'route preview must NOT render a <polygon> (would auto-close the shape)').toBeNull();
  });

  /**
   * Test W: In drawRouteMode, the first vertex circle has aria-label "Vertex 1"
   * (not "Close polygon"), confirming the snap-to-close affordance is suppressed
   * for routes (routes finish via Enter or double-click, never by first-vertex snap).
   */
  it('Test W: first vertex circle in drawRouteMode has aria-label "Vertex 1" not "Close polygon"', () => {
    const { container } = renderMapCanvas({
      drawRouteMode: true,
      pendingVertices: TWO_VERTS,
    });

    const previewG = container.querySelector('.region-preview');
    expect(previewG).not.toBeNull();

    const circles = previewG!.querySelectorAll('circle');
    expect(circles.length, 'preview circles must equal vertex count').toBe(TWO_VERTS.length);

    const firstCircle = circles[0];
    const firstLabel = firstCircle.getAttribute('aria-label');
    expect(firstLabel, 'first vertex in route mode must be labelled "Vertex 1" not "Close polygon"')
      .toBe('Vertex 1');
    expect(firstLabel).not.toBe('Close polygon');
  });
});

// ── BUG-A fix (51-07): d3 zoom filter — pan blocked in draw modes ─────────────
//
// Root cause: the d3 zoom behavior had no .filter(), so mousedown always started a pan,
// even during draw modes (drawRouteMode, drawRegionMode, addPinMode, paintTerrainMode).
//
// Fix: add a .filter() that reads isDrawingRef.current (a ref synced each render to
// the isDrawing flag) so pan-start gestures (mousedown) are blocked while drawing.
// Wheel events always pass so scroll-to-zoom still works in all modes.
//
// Test strategy: d3-zoom's full pan pipeline requires SVG geometry (svg.width.baseVal)
// which jsdom 25 does not implement, making transform-change assertions unreliable.
// Instead, we capture the actual filter function via the d3-zoom spy mock (top of file)
// and call it directly. This directly tests the filter's behavior — the root fix for BUG-A —
// without requiring d3's pan pipeline to run in jsdom.
//
// The spy captures the filter AFTER the component's useEffect runs (inside act()),
// so the closure over isDrawingRef reflects the live draw-mode state.
describe('MapCanvas — d3 zoom filter disables pan in draw modes (BUG-A, 51-07)', () => {
  /**
   * Test AA: When drawRouteMode=true, the zoom filter returns false for mousedown
   * (d3 pan-start is blocked) and true for wheel (scroll-to-zoom is always allowed).
   *
   * We capture the filter function after render via the d3-zoom spy mock (top of file).
   * The captured closure reads isDrawingRef.current, which is initialized from isDrawing
   * at render time (useRef(isDrawing)), so it correctly reflects drawRouteMode=true.
   *
   * RED pre-fix: filter is not set → capturedZoomFilter.fn is null → assertion fails.
   * GREEN post-fix: filter captures correctly → mousedown → false, wheel → true → PASS.
   */
  it('Test AA: zoom filter returns false for mousedown and true for wheel while drawRouteMode=true', () => {
    // Render with draw mode active so isDrawingRef.current = true inside the component.
    renderMapCanvas({ drawRouteMode: true });

    const filter = capturedZoomFilter.fn;
    expect(filter, 'capturedZoomFilter.fn must be set — .filter() was not called on the zoom behavior').not.toBeNull();

    // Wheel always passes (scroll-to-zoom must work in all modes).
    expect(filter!({ type: 'wheel', button: 0 }), 'wheel: filter must return true').toBe(true);

    // Non-wheel events are blocked while any draw mode is active.
    expect(filter!({ type: 'mousedown', button: 0 }), 'mousedown in draw mode: filter must return false').toBe(false);
    expect(filter!({ type: 'pointermove', button: 0 }), 'pointermove in draw mode: filter must return false').toBe(false);
  });

  /**
   * Test AB: When no draw mode is active (drawRouteMode=false), the filter returns
   * true for a primary-button mousedown (pan is allowed in idle mode).
   *
   * This is the no-regression guard: the filter must not over-block.
   * If this test turns RED, the filter is blocking pan even when no draw mode is armed.
   */
  it('Test AB: zoom filter returns true for primary-button mousedown when no draw mode is active', () => {
    renderMapCanvas({ drawRouteMode: false });

    const filter = capturedZoomFilter.fn;
    expect(filter, 'capturedZoomFilter.fn must be set').not.toBeNull();

    // Idle mode: primary-button, no ctrlKey → filter returns true (pan allowed).
    expect(filter!({ type: 'mousedown', button: 0, ctrlKey: false }),
      'idle mode mousedown: filter must return true (pan allowed)').toBe(true);

    // Ctrl+click (Ctrl+mousedown) is blocked by d3 default convention (button modifier) but
    // the filter is consistent: ctrlKey=true, button=0 → returns false (same as d3 default).
    expect(filter!({ type: 'mousedown', button: 0, ctrlKey: true }),
      'idle mode ctrl+mousedown: filter must return false (d3 convention)').toBe(false);

    // Wheel always passes regardless of draw mode.
    expect(filter!({ type: 'wheel', button: 0 }), 'wheel in idle mode: filter must return true').toBe(true);
  });

  /**
   * Test AC: Regardless of draw mode, a wheel event always passes the filter.
   * Scroll-to-zoom is never blocked so the map remains zoomable while drawing routes.
   */
  it('Test AC: zoom filter always returns true for wheel events (zoom works in all modes)', () => {
    // Test with addPinMode, drawRegionMode, and drawRouteMode — all should pass wheel.
    for (const props of [
      { addPinMode: true },
      { drawRegionMode: true },
      { drawRouteMode: true },
    ]) {
      cleanup();
      renderMapCanvas(props);
      const filter = capturedZoomFilter.fn;
      expect(filter, `capturedZoomFilter.fn must be set for props ${JSON.stringify(props)}`).not.toBeNull();
      expect(filter!({ type: 'wheel', button: 0 }),
        `wheel must return true when ${JSON.stringify(props)}`).toBe(true);
    }
  });
});

// ── BUG-B fix (51-07): pin click in drawRouteMode snaps a route vertex ──────────
//
// Root cause: PinCircle's handlePointerUp treated every non-moved click as onNavigate,
// regardless of whether the user was in route-draw mode. Clicking a pin in route-draw
// mode navigated to the entry instead of appending a route vertex at the pin's coords.
//
// Fix: when drawRouteMode=true, handlePointerUp calls onRouteVertexAtPin(pin) instead
// of onNavigate(pin.entryId). Pin drag is also suppressed in route mode (handlePointerMove
// skips the `moved` update) so any pointer movement during route draw is still treated
// as a click → vertex snap.
//
// Note: navigate is mocked at the module level (see top of file) so we can assert
// it is NOT called during route-draw clicks.
describe('PinCircle — route-vertex snap replaces navigation in drawRouteMode (BUG-B, 51-07)', () => {
  /**
   * Test BA: In drawRouteMode, a non-moved click on a pin calls onRouteVertexAtPin
   * with the clicked pin's exact data (x, y, id, etc.).
   *
   * RED pre-fix: onRouteVertexAtPin was never wired, clicks navigated instead → FAIL.
   * GREEN post-fix: onRouteVertexAtPin is called with the pin → PASS.
   */
  it('Test BA: click on pin in drawRouteMode calls onRouteVertexAtPin with the pin', () => {
    const onRouteVertexAtPin = vi.fn();
    const { container } = renderMapCanvas({
      pins: [TEST_PIN],
      drawRouteMode: true,
      onRouteVertexAtPin,
    });

    const pinGroup = container.querySelector('.pins g[aria-label]') as Element;
    expect(pinGroup, 'pin group must exist').not.toBeNull();
    stubPointerCapture(pinGroup);

    // Simulate a non-moved click (no pointermove fired between down and up).
    fireEvent.pointerDown(pinGroup, { pointerId: 1, clientX: 500, clientY: 500, bubbles: true });
    fireEvent.pointerUp(pinGroup, { pointerId: 1, clientX: 500, clientY: 500, bubbles: true });

    expect(onRouteVertexAtPin, 'onRouteVertexAtPin must be called exactly once').toHaveBeenCalledTimes(1);
    const calledWith = onRouteVertexAtPin.mock.calls[0][0] as MapPin;
    expect(calledWith.id, 'called with the correct pin id').toBe(TEST_PIN.id);
    expect(calledWith.x, 'called with pin.x').toBe(TEST_PIN.x);
    expect(calledWith.y, 'called with pin.y').toBe(TEST_PIN.y);
  });

  /**
   * Test BB: In drawRouteMode, a non-moved click on a pin does NOT call navigate.
   * The route-vertex handler replaces navigation — no entry navigation occurs.
   *
   * RED pre-fix: navigate was called (bug — entry opened instead of vertex appended) → FAIL.
   * GREEN post-fix: navigate is NOT called → PASS.
   */
  it('Test BB: click on pin in drawRouteMode does NOT navigate to the entry', () => {
    const onRouteVertexAtPin = vi.fn();
    const { container } = renderMapCanvas({
      pins: [TEST_PIN],
      drawRouteMode: true,
      onRouteVertexAtPin,
    });

    const pinGroup = container.querySelector('.pins g[aria-label]') as Element;
    expect(pinGroup, 'pin group must exist').not.toBeNull();
    stubPointerCapture(pinGroup);

    fireEvent.pointerDown(pinGroup, { pointerId: 1, clientX: 500, clientY: 500, bubbles: true });
    fireEvent.pointerUp(pinGroup, { pointerId: 1, clientX: 500, clientY: 500, bubbles: true });

    // mockNavigate is the vi.fn() returned by the mocked useNavigate (see top of file).
    expect(mockNavigate, 'navigate must NOT be called during a route-draw pin click')
      .not.toHaveBeenCalled();
  });

  /**
   * Test BC: In idle mode (drawRouteMode=false), a non-moved click on a pin DOES call
   * navigate. This is the no-regression guard for pin navigation in normal use.
   *
   * If this test turns RED, the BUG-B fix accidentally broke normal pin navigation.
   */
  it('Test BC: click on pin in idle mode (drawRouteMode=false) calls navigate (no regression)', () => {
    const { container } = renderMapCanvas({
      pins: [TEST_PIN],
      drawRouteMode: false,
    });

    const pinGroup = container.querySelector('.pins g[aria-label]') as Element;
    expect(pinGroup, 'pin group must exist').not.toBeNull();
    stubPointerCapture(pinGroup);

    fireEvent.pointerDown(pinGroup, { pointerId: 1, clientX: 500, clientY: 500, bubbles: true });
    fireEvent.pointerUp(pinGroup, { pointerId: 1, clientX: 500, clientY: 500, bubbles: true });

    expect(mockNavigate, 'idle mode: pin click must call navigate to entry detail')
      .toHaveBeenCalledTimes(1);
    expect(mockNavigate.mock.calls[0][0] as string).toContain(TEST_PIN.entryId);
  });
});
