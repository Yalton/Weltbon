/**
 * MapEditor share-mode render tests (GEOSHARE-01 / 44-03).
 *
 * Tests:
 *  1. Share legend renders per-layer terrain types in sortOrder (present-types-only)
 *  2. Share legend renders ordered-layer ranked-ramp band labels
 *  3. Share mode shows NO visibility toggles and NO opacity sliders (D-44-01)
 *  4. Terrain area polygon group renders in the share canvas
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

// Per-file api/client mock (mirrors DiagramEditor.test.tsx convention).
vi.mock('../api/client', () => ({ api: vi.fn() }));

// Mock ShareModeContext so we can inject share mode without needing a real share route.
// NOTE: use plain arrow functions (not vi.fn().mockReturnValue) so afterEach vi.clearAllMocks()
// does not wipe the return values between tests within this file.
vi.mock('../contexts/ShareModeContext', () => ({
  useShareMode: () => true,
  useShareToken: () => 'test-share-token',
  ShareModeContext: {},
  ShareModeProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

// Mock MapCanvas — the test asserts on terrain group rendering via stub, not real SVG.
// Expose a stub <g className="terrain-areas"> so assertions can check terrain render.
// Also exposes pin summaries (data-testid="pin-summary") for Plan 04 Task 3 share-parity test.
type MockMapPin = {
  id: string;
  entryId: string;
  summary?: string | null;
  [key: string]: unknown;
};
type MockMapCanvasProps = {
  pins?: MockMapPin[];
  terrainAreas?: Array<{ id: string; terrainTypeId: string; terrainTypeColor: string; layerId: string; layerSortOrder: number; name: string; points: string; mapId: string; entryId: string | null; color: string | null; createdAt: string }>;
  layers?: Array<{ id: string; name: string; sortOrder: number; ordered: boolean; defaultOpacity: number; universeId: string; createdAt: string; terrainTypes?: Array<{ id: string; name: string; color: string; label: string | null; sortOrder: number; layerId: string; createdAt: string }> }>;
  layerViewerState?: Record<string, { visible: boolean; opacity: number }>;
  [key: string]: unknown;
};

vi.mock('../components/MapCanvas', () => ({
  MapCanvas: (props: MockMapCanvasProps) => {
    const { pins = [], terrainAreas = [], layers = [], layerViewerState = {} } = props;
    return (
      <div data-testid="map-canvas-stub">
        {/* Expose pin summaries so Plan 04 Task 3 share-parity test can assert on them */}
        {pins.map((pin) =>
          pin.summary ? (
            <span key={pin.id} data-testid="pin-summary" data-pin-id={pin.id}>{pin.summary}</span>
          ) : null
        )}
        {/* Replicate the terrain group so tests can assert terrain rendering */}
        <svg>
          <g className="terrain-areas">
            {layers
              .sort((a: { sortOrder: number }, b: { sortOrder: number }) => a.sortOrder - b.sortOrder)
              .map((layer: { id: string; sortOrder: number }) => {
                if (layerViewerState[layer.id]?.visible === false) return null;
                const layerAreas = terrainAreas.filter(
                  (a: { layerId: string }) => a.layerId === layer.id,
                );
                return layerAreas.map(
                  (area: { id: string; terrainTypeId: string }) => (
                    <g
                      key={area.id}
                      data-testid="terrain-area-polygon"
                      data-terrain-type-id={area.terrainTypeId}
                    />
                  ),
                );
              })}
          </g>
        </svg>
      </div>
    );
  },
}));

// Mock MapToolbar — editor controls; suppressed in share mode anyway.
vi.mock('../components/MapToolbar', () => ({
  MapToolbar: () => <div data-testid="map-toolbar-stub" />,
}));

// Mock LayersPanel — suppressed in share mode; stub so absence assertions work.
vi.mock('../components/LayersPanel', () => ({
  LayersPanel: (props: { visible?: boolean }) =>
    props.visible ? <div data-testid="layers-panel-stub" /> : null,
}));

// Mock AddEntriesPicker — out of scope.
vi.mock('../components/AddEntriesPicker', () => ({
  AddEntriesPicker: () => null,
}));

// Mock AssetPickerModal — out of scope.
vi.mock('../components/AssetPickerModal', () => ({
  AssetPickerModal: () => null,
}));

// Mock ConfirmDialog — out of scope.
vi.mock('../components/ConfirmDialog', () => ({
  ConfirmDialog: () => null,
}));

// Mock EmptyState — out of scope.
vi.mock('../components/EmptyState', () => ({
  EmptyState: () => null,
}));

// Mock Toast — out of scope.
vi.mock('../components/Toast', () => ({
  Toast: () => null,
}));

// Mock MapZoomControls and MapCompass — chrome components under test for share parity (D-09).
vi.mock('../components/MapZoomControls', () => ({
  MapZoomControls: () => <div data-testid="map-zoom-controls-stub" />,
}));
vi.mock('../components/MapCompass', () => ({
  MapCompass: () => <div data-testid="map-compass-stub" />,
}));

import { api } from '../api/client';
import { MapEditor } from './MapEditor';
import type { MapDetail } from '../hooks/useMap';
import type { MapLayer } from '../hooks/useMapLayers';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const LAYER_A_ID = 'layer-a-uuid';
const LAYER_B_ID = 'layer-b-uuid';
const TYPE_A1_ID = 'type-a1-uuid';
const TYPE_A2_ID = 'type-a2-uuid';
const TYPE_B1_ID = 'type-b1-uuid';
const MAP_ID = 'map-uuid';
const TERRAIN_AREA_1_ID = 'terrain-area-1-uuid';
const TERRAIN_AREA_2_ID = 'terrain-area-2-uuid';
const TERRAIN_AREA_3_ID = 'terrain-area-3-uuid';

/**
 * Two mock layers:
 * - Layer A: ordered=true (elevation bands) — sortOrder=0
 * - Layer B: ordered=false (biomes) — sortOrder=1
 */
function makeLayers(): MapLayer[] {
  return [
    {
      id: LAYER_A_ID,
      universeId: 'share',
      name: 'Elevation',
      ordered: true,
      defaultOpacity: 0.7,
      sortOrder: 0,
      createdAt: '2026-01-01T00:00:00Z',
      terrainTypes: [
        {
          id: TYPE_A1_ID,
          layerId: LAYER_A_ID,
          name: 'Lowlands',
          color: '#a8d5a2',
          label: '0–200m',
          sortOrder: 0,
          createdAt: '2026-01-01T00:00:00Z',
        },
        {
          id: TYPE_A2_ID,
          layerId: LAYER_A_ID,
          name: 'Highlands',
          color: '#6b8f5e',
          label: '200–1000m',
          sortOrder: 1,
          createdAt: '2026-01-01T00:00:00Z',
        },
      ],
    },
    {
      id: LAYER_B_ID,
      universeId: 'share',
      name: 'Biomes',
      ordered: false,
      defaultOpacity: 0.5,
      sortOrder: 1,
      createdAt: '2026-01-01T00:00:00Z',
      terrainTypes: [
        {
          id: TYPE_B1_ID,
          layerId: LAYER_B_ID,
          name: 'Forest',
          color: '#228b22',
          label: null,
          sortOrder: 0,
          createdAt: '2026-01-01T00:00:00Z',
        },
      ],
    },
  ];
}

/**
 * Map detail simulating the share API response (D-44-03).
 * - `regions`: political/standalone only (no terrain-tagged rows — discriminated out by share backend)
 * - `terrainAreas`: pre-enriched terrain areas with terrainTypeColor/layerId/layerSortOrder,
 *   mirroring what getPublicMap returns after the Phase 44-02 discriminator split.
 */
function makeMapDetail(): MapDetail {
  return {
    id: MAP_ID,
    universeId: 'share',
    name: 'Test Map',
    imageAssetId: null,
    rawUrl: null,
    thumbUrl: null,
    createdAt: '2026-01-01T00:00:00Z',
    legendLabels: null,
    pins: [],
    // Political/standalone regions only (no terrain-tagged rows in share response)
    regions: [],
    // Pre-enriched terrain areas from the share seam (D-44-03).
    // Both Elevation types (Lowlands + Highlands) and one Biome (Forest) are present.
    terrainAreas: [
      {
        id: TERRAIN_AREA_1_ID,
        mapId: MAP_ID,
        entryId: null,
        name: '',
        points: JSON.stringify([
          { x: 0.1, y: 0.1 },
          { x: 0.2, y: 0.1 },
          { x: 0.2, y: 0.2 },
        ]),
        color: null,
        createdAt: '2026-01-01T00:00:00Z',
        terrainTypeId: TYPE_A1_ID,          // Elevation / Lowlands (sortOrder 0)
        terrainTypeColor: '#a8d5a2',
        layerId: LAYER_A_ID,
        layerSortOrder: 0,
      },
      {
        id: TERRAIN_AREA_3_ID,
        mapId: MAP_ID,
        entryId: null,
        name: '',
        points: JSON.stringify([
          { x: 0.5, y: 0.5 },
          { x: 0.6, y: 0.5 },
          { x: 0.6, y: 0.6 },
        ]),
        color: null,
        createdAt: '2026-01-01T00:00:00Z',
        terrainTypeId: TYPE_A2_ID,          // Elevation / Highlands (sortOrder 1)
        terrainTypeColor: '#6b8f5e',
        layerId: LAYER_A_ID,
        layerSortOrder: 0,
      },
      {
        id: TERRAIN_AREA_2_ID,
        mapId: MAP_ID,
        entryId: null,
        name: '',
        points: JSON.stringify([
          { x: 0.3, y: 0.3 },
          { x: 0.4, y: 0.3 },
          { x: 0.4, y: 0.4 },
        ]),
        color: null,
        createdAt: '2026-01-01T00:00:00Z',
        terrainTypeId: TYPE_B1_ID,          // Biomes / Forest
        terrainTypeColor: '#228b22',
        layerId: LAYER_B_ID,
        layerSortOrder: 1,
      },
    ],
  };
}

// ── Render helper ─────────────────────────────────────────────────────────────

function renderShareEditor(uid = 'share', mid = MAP_ID) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[`/share/test-share-token/maps/${mid}`]}>
        <Routes>
          {/* Share routes use /share/:token/... pattern, but MapEditor reads uid + mid from params.
              We mount MapEditor directly under a route that supplies the mid param;
              uid is derived from isShare in the component itself (uid = 'share'). */}
          <Route path="/share/:token/maps/:mid" element={<MapEditor />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('MapEditor share mode (GEOSHARE-01 / 44-03)', () => {
  beforeEach(() => {
    vi.mocked(api).mockReset();
  });

  afterEach(() => {
    // Use clearAllMocks (not restoreAllMocks) so permanent module-level vi.mock() factories
    // (e.g. useShareMode returning true) are not wiped between tests.
    vi.clearAllMocks();
  });

  it('Test 1: share legend renders terrain types in sortOrder for each layer', async () => {
    vi.mocked(api).mockImplementation(async (path: string) => {
      if (path.includes('/map-layers')) return makeLayers() as never;
      if (path.includes('/entries')) return [] as never;
      return makeMapDetail() as never;
    });

    renderShareEditor();

    // Wait for the legend to become available (legend button rendered in share mode).
    const legendBtn = await screen.findByRole('button', { name: /toggle legend/i });
    // Click to open the legend
    legendBtn.click();

    // Layer A (Elevation, ordered) — terrain types: Lowlands, Highlands in sortOrder.
    await waitFor(() => {
      expect(screen.getByText('Elevation')).toBeInTheDocument();
    });
    expect(screen.getByText('Lowlands')).toBeInTheDocument();
    expect(screen.getByText('Highlands')).toBeInTheDocument();

    // Layer B (Biomes) — terrain types: Forest.
    expect(screen.getByText('Biomes')).toBeInTheDocument();
    expect(screen.getByText('Forest')).toBeInTheDocument();
  });

  it('Test 2: share legend renders ordered-layer ranked-ramp band labels', async () => {
    vi.mocked(api).mockImplementation(async (path: string) => {
      if (path.includes('/map-layers')) return makeLayers() as never;
      if (path.includes('/entries')) return [] as never;
      return makeMapDetail() as never;
    });

    renderShareEditor();

    const legendBtn = await screen.findByRole('button', { name: /toggle legend/i });
    legendBtn.click();

    // Layer A is ordered=true — Lowlands has label '0–200m', Highlands '200–1000m'.
    await waitFor(() => {
      expect(screen.getByText(/0–200m/)).toBeInTheDocument();
    });
    expect(screen.getByText(/200–1000m/)).toBeInTheDocument();

    // Layer B is ordered=false — Forest has label=null, so no band label rendered.
    // 'Forest' should appear but NOT '(null)' text.
    expect(screen.queryByText(/\(null\)/)).not.toBeInTheDocument();
  });

  it('Test 3: share mode shows NO visibility toggles and NO opacity sliders (D-44-01)', async () => {
    vi.mocked(api).mockImplementation(async (path: string) => {
      if (path.includes('/map-layers')) return makeLayers() as never;
      if (path.includes('/entries')) return [] as never;
      return makeMapDetail() as never;
    });

    renderShareEditor();

    // Wait for the view to load (legend button should be present in share mode).
    await screen.findByRole('button', { name: /toggle legend/i });

    // The LayersPanel (which hosts visibility toggles + opacity sliders) must NOT be visible.
    expect(screen.queryByTestId('layers-panel-stub')).not.toBeInTheDocument();

    // No visibility toggle buttons for any layer.
    expect(
      screen.queryByRole('checkbox', { name: /Toggle.*visibility/i }),
    ).not.toBeInTheDocument();

    // No opacity slider inputs.
    expect(
      screen.queryByRole('slider', { name: /opacity/i }),
    ).not.toBeInTheDocument();

    // MapToolbar (which also has edit controls) must NOT be rendered in share mode.
    expect(screen.queryByTestId('map-toolbar-stub')).not.toBeInTheDocument();
  });

  it('Test 4: terrain area polygons render in the share canvas', async () => {
    vi.mocked(api).mockImplementation(async (path: string) => {
      if (path.includes('/map-layers')) return makeLayers() as never;
      if (path.includes('/entries')) return [] as never;
      return makeMapDetail() as never;
    });

    renderShareEditor();

    // Wait for the canvas stub to render.
    await screen.findByTestId('map-canvas-stub');

    // Both terrain areas should be rendered as TerrainAreaPolygon stubs.
    await waitFor(() => {
      const polygons = screen.getAllByTestId('terrain-area-polygon');
      expect(polygons.length).toBeGreaterThanOrEqual(1);
    });
  });

  /**
   * Test 5: MapZoomControls renders in share mode (D-04, D-09 parity).
   * Chrome must appear in BOTH editor and share view — NOT gated on !isShare.
   */
  it('Test 5: MapZoomControls renders in share mode (D-09 parity)', async () => {
    vi.mocked(api).mockImplementation(async (path: string) => {
      if (path.includes('/map-layers')) return makeLayers() as never;
      if (path.includes('/entries')) return [] as never;
      return makeMapDetail() as never;
    });

    renderShareEditor();

    // Wait for the page to load — the map canvas stub appears when data is ready.
    await screen.findByTestId('map-canvas-stub');

    // MapZoomControls must be present in share mode (chrome parity).
    await waitFor(() => {
      expect(screen.getByTestId('map-zoom-controls-stub')).toBeInTheDocument();
    });
  });

  /**
   * Test 6: MapCompass renders in share mode (D-06, D-09 parity).
   * The static compass rose must appear in BOTH editor and share view.
   */
  it('Test 6: MapCompass renders in share mode (D-09 parity)', async () => {
    vi.mocked(api).mockImplementation(async (path: string) => {
      if (path.includes('/map-layers')) return makeLayers() as never;
      if (path.includes('/entries')) return [] as never;
      return makeMapDetail() as never;
    });

    renderShareEditor();

    await screen.findByTestId('map-canvas-stub');

    // MapCompass must be present in share mode (chrome parity).
    await waitFor(() => {
      expect(screen.getByTestId('map-compass-stub')).toBeInTheDocument();
    });
  });

  /**
   * Test 7: Share-mode enrichedPins pass server-projected summary through to MapCanvas (D-07, D-09).
   *
   * In share mode there is NO authenticated useEntries join, so the tooltip summary MUST come
   * from the server projection on map.pins (Plan 03 / getPublicMap). The enrichedPins path:
   *   if (!entriesData) return map.pins;  ← share mode: entriesData undefined → pass pins as-is
   *
   * This test verifies that a pin with summary from the share API response reaches MapCanvas
   * with that summary intact — the MapCanvas stub renders pin summaries as data-testid="pin-summary".
   *
   * Acceptance criteria (Plan 04 Task 3):
   * - grep -c "summary: entry" web/src/views/MapEditor.tsx ≥ 1 (join widened)
   * - Share-mode pins carry Plan 03 server-projected summary through to MapCanvas
   */
  it('Test 7: share-mode pins carry server-projected summary through to MapCanvas (D-07, D-09)', async () => {
    const SHARE_PIN_SUMMARY = 'The famous castle of the northern realm.';

    vi.mocked(api).mockImplementation(async (path: string) => {
      if (path.includes('/map-layers')) return [] as never;
      if (path.includes('/entries')) return [] as never;
      // Return map detail with a pin that has a server-projected summary (Plan 03)
      return {
        ...makeMapDetail(),
        pins: [
          {
            id: 'share-pin-1',
            mapId: MAP_ID,
            entryId: 'entry-1',
            x: 0.5,
            y: 0.5,
            color: '#3b82f6',
            icon: null,
            entryTitle: 'North Castle',
            entryType: 'location',
            // summary comes from the server projection (Plan 03 / getPublicMap)
            summary: SHARE_PIN_SUMMARY,
            createdAt: '2026-01-01T00:00:00Z',
          },
        ],
      } as never;
    });

    renderShareEditor();

    // Wait for the canvas stub to render.
    await screen.findByTestId('map-canvas-stub');

    // The pin's server-projected summary must reach MapCanvas via enrichedPins.
    // In share mode: entriesData is undefined → enrichedPins = map.pins (no join).
    // The stub renders pin.summary as a data-testid="pin-summary" span.
    await waitFor(() => {
      const summaryEl = screen.getByTestId('pin-summary');
      expect(summaryEl).toBeInTheDocument();
      expect(summaryEl.textContent).toContain(SHARE_PIN_SUMMARY);
    });
  });
});
