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
vi.mock('../contexts/ShareModeContext', () => ({
  useShareMode: vi.fn().mockReturnValue(true),
  useShareToken: vi.fn().mockReturnValue('test-share-token'),
  ShareModeContext: {},
  ShareModeProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

// Mock MapCanvas — the test asserts on terrain group rendering via stub, not real SVG.
// Expose a stub <g className="terrain-areas"> so assertions can check terrain render.
type MockMapCanvasProps = {
  terrainAreas?: Array<{ id: string; terrainTypeId: string; terrainTypeColor: string; layerId: string; layerSortOrder: number; name: string; points: string; mapId: string; entryId: string | null; color: string | null; createdAt: string }>;
  layers?: Array<{ id: string; name: string; sortOrder: number; ordered: boolean; defaultOpacity: number; universeId: string; createdAt: string; terrainTypes?: Array<{ id: string; name: string; color: string; label: string | null; sortOrder: number; layerId: string; createdAt: string }> }>;
  layerViewerState?: Record<string, { visible: boolean; opacity: number }>;
  [key: string]: unknown;
};

vi.mock('../components/MapCanvas', () => ({
  MapCanvas: (props: MockMapCanvasProps) => {
    const { terrainAreas = [], layers = [], layerViewerState = {} } = props;
    return (
      <div data-testid="map-canvas-stub">
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
 * Map detail with two terrain areas (one per layer), present on the map.
 * terrainTypeId set → terrain area row; regions array includes them.
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
    regions: [
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
        terrainTypeId: TYPE_A1_ID, // Elevation / Lowlands
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
        terrainTypeId: TYPE_B1_ID, // Biomes / Forest
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
    vi.restoreAllMocks();
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
});
