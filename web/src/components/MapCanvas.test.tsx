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
import type { TerrainAreaRegion, MapRegion } from '../hooks/useMap';
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
