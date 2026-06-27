/**
 * MapEditor share-mode render tests (GEOSHARE-01 / 44-03) +
 * MapEditor route interaction tests (ROUTE-02, Plan 07).
 *
 * Share-mode tests (Tests 1-7):
 *  1. Share legend renders per-layer terrain types in sortOrder (present-types-only)
 *  2. Share legend renders ordered-layer ranked-ramp band labels
 *  3. Share mode shows NO visibility toggles and NO opacity sliders (D-44-01)
 *  4. Terrain area polygon group renders in the share canvas
 *  5. MapZoomControls renders in share mode (D-09 parity)
 *  6. MapCompass renders in share mode (D-09 parity)
 *  7. share-mode pins carry server-projected summary through to MapCanvas (D-07, D-09)
 *
 * Route interaction tests (ROUTE-02, Plan 07):
 *  R1. lineStyle toggle fires updateRoute
 *  R2. width preset fires updateRoute
 *  R3. showArrow toggle fires updateRoute
 *  R4. rename fires updateRoute
 *  R5. relink fires updateRoute
 *  R6. delete-confirm fires deleteRoute
 *  R7. left-click on linked route navigates (editor path)
 *  R8. left-click on linked route navigates (share path) — in share mode
 *  R9. share mode suppresses route context menu (T-51-13)
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import React from 'react';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

// Per-file api/client mock (mirrors DiagramEditor.test.tsx convention).
vi.mock('../api/client', () => ({ api: vi.fn() }));

// Mutable flags for per-test share mode control.
// Default to share mode (true) to preserve existing tests.
// Route interaction tests set these to false in beforeEach.
// Using plain variable references so vi.clearAllMocks() never wipes them.
let _shareMode = true;
let _shareToken: string | null = 'test-share-token';

// Mock ShareModeContext — uses variable-backed closures so per-test overrides work.
vi.mock('../contexts/ShareModeContext', () => ({
  useShareMode: () => _shareMode,
  useShareToken: () => _shareToken,
  ShareModeContext: {},
  ShareModeProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

// Mock MapCanvas — the test asserts on terrain group rendering via stub, not real SVG.
// Expose a stub <g className="terrain-areas"> so assertions can check terrain render.
// Also exposes pin summaries (data-testid="pin-summary") for Plan 04 Task 3 share-parity test.
// Also exposes route stubs (data-testid="route-stub") for ROUTE-02 Plan 07 interaction tests.
type MockMapPin = {
  id: string;
  entryId: string;
  summary?: string | null;
  [key: string]: unknown;
};
type MockMapRoute = {
  id: string;
  entryId: string | null;
  name: string;
  lineStyle: 'solid' | 'dashed';
  width: number;
  showArrow: boolean;
  [key: string]: unknown;
};
type MockMapCanvasProps = {
  pins?: MockMapPin[];
  terrainAreas?: Array<{ id: string; terrainTypeId: string; terrainTypeColor: string; layerId: string; layerSortOrder: number; name: string; points: string; mapId: string; entryId: string | null; color: string | null; createdAt: string }>;
  layers?: Array<{ id: string; name: string; sortOrder: number; ordered: boolean; defaultOpacity: number; universeId: string; createdAt: string; terrainTypes?: Array<{ id: string; name: string; color: string; label: string | null; sortOrder: number; layerId: string; createdAt: string }> }>;
  layerViewerState?: Record<string, { visible: boolean; opacity: number }>;
  routes?: MockMapRoute[];
  onRouteClick?: (route: MockMapRoute) => void;
  onRouteContextMenu?: (route: MockMapRoute, clientX: number, clientY: number) => void;
  [key: string]: unknown;
};

vi.mock('../components/MapCanvas', () => ({
  MapCanvas: (props: MockMapCanvasProps) => {
    const { pins = [], terrainAreas = [], layers = [], layerViewerState = {}, routes = [], onRouteClick, onRouteContextMenu } = props;
    return (
      <div data-testid="map-canvas-stub">
        {/* Expose pin summaries so Plan 04 Task 3 share-parity test can assert on them */}
        {pins.map((pin) =>
          pin.summary ? (
            <span key={pin.id} data-testid="pin-summary" data-pin-id={pin.id}>{pin.summary}</span>
          ) : null
        )}
        {/* Route stubs — expose click + right-click triggers for ROUTE-02 Plan 07 tests */}
        {routes.map((route) => (
          <div key={route.id} data-testid="route-stub" data-route-id={route.id}>
            <button
              data-testid={`route-click-${route.id}`}
              onClick={() => onRouteClick?.(route)}
            >
              route-click
            </button>
            <button
              data-testid={`route-ctx-${route.id}`}
              onClick={() => onRouteContextMenu?.(route, 100, 100)}
            >
              route-ctx
            </button>
          </div>
        ))}
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
// Exposes toggle buttons so tests can arm draw modes to assert banner / CTA behaviour.
vi.mock('../components/MapToolbar', () => ({
  MapToolbar: ({
    onToggleAddPinMode,
    onToggleDrawRouteMode,
    onToggleDrawRegionMode,
  }: {
    onToggleAddPinMode?: () => void;
    onToggleDrawRouteMode?: () => void;
    onToggleDrawRegionMode?: () => void;
  }) => (
    <div data-testid="map-toolbar-stub">
      {onToggleAddPinMode && (
        <button data-testid="toolbar-add-pin-toggle" onClick={onToggleAddPinMode} />
      )}
      {onToggleDrawRouteMode && (
        <button data-testid="toolbar-draw-route-toggle" onClick={onToggleDrawRouteMode} />
      )}
      {onToggleDrawRegionMode && (
        <button data-testid="toolbar-draw-region-toggle" onClick={onToggleDrawRegionMode} />
      )}
    </div>
  ),
}));

// Mock LayersPanel — suppressed in share mode; stub so absence assertions work.
vi.mock('../components/LayersPanel', () => ({
  LayersPanel: (props: { visible?: boolean }) =>
    props.visible ? <div data-testid="layers-panel-stub" /> : null,
}));

// Mock AddEntriesPicker — renders a stub button when open, for relink mutation tests (R5).
vi.mock('../components/AddEntriesPicker', () => ({
  AddEntriesPicker: ({ open, onAdd }: { open?: boolean; onAdd?: (id: string) => void }) =>
    open ? (
      <button
        data-testid="add-entries-picker-select"
        onClick={() => onAdd?.('entry-new-uuid')}
      >
        Select entry
      </button>
    ) : null,
}));

// Mock AssetPickerModal — out of scope.
vi.mock('../components/AssetPickerModal', () => ({
  AssetPickerModal: () => null,
}));

// Mock ConfirmDialog — renders a confirm button when open, for delete mutation tests (R6).
// Backward-safe: in share mode the !isShare gate prevents ConfirmDialog from mounting,
// so the mock never renders open=true in existing share-mode tests.
vi.mock('../components/ConfirmDialog', () => ({
  ConfirmDialog: ({
    open,
    onConfirm,
    confirmLabel,
  }: {
    open: boolean;
    onConfirm?: () => void;
    confirmLabel?: string;
    onOpenChange?: (open: boolean) => void;
    title?: string;
    body?: string;
    destructive?: boolean;
  }) =>
    open ? (
      <button data-testid="confirm-dialog-confirm" onClick={onConfirm}>
        {confirmLabel ?? 'Confirm'}
      </button>
    ) : null,
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
      secret: false,
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
      secret: false,
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
    // Phase 51 ROUTE-01: routes array (empty for terrain-focused share tests).
    routes: [],
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
        secret: false,
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
        secret: false,
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
        secret: false,
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

    // Phase 52 SEARCH-01 (D-04): MapToolbar NOW renders in share mode (for the search input).
    // The toolbar stub IS present — but mutation/editing buttons must NOT be rendered
    // (no onToggleAddPinMode / onToggleDrawRegionMode passed in share mode).
    expect(screen.queryByTestId('map-toolbar-stub')).toBeInTheDocument();
    expect(screen.queryByTestId('toolbar-add-pin-toggle')).not.toBeInTheDocument();
    expect(screen.queryByTestId('toolbar-draw-region-toggle')).not.toBeInTheDocument();
    expect(screen.queryByTestId('toolbar-draw-route-toggle')).not.toBeInTheDocument();
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

// ── Route interaction tests (ROUTE-02, Plan 07) ───────────────────────────────

describe('MapEditor route interactions (ROUTE-02, Plan 07)', () => {
  const ROUTE_1_ID = 'route-1-uuid';
  const LINKED_ENTRY_ID = 'entry-linked-uuid';
  const EDITOR_UID = 'test-universe-uuid';

  // Mock route used across tests
  const ROUTE_FIXTURE = {
    id: ROUTE_1_ID,
    mapId: MAP_ID,
    entryId: LINKED_ENTRY_ID,
    name: 'The Kings Road',
    points: JSON.stringify([{ x: 0.1, y: 0.1 }, { x: 0.5, y: 0.5 }]),
    color: '#3b82f6',
    lineStyle: 'solid' as const,
    width: 4,
    showArrow: false,
    secret: false,
    createdAt: '2026-01-01T00:00:00Z',
  };

  // Route update stub returned by api for PATCH/DELETE calls
  const routeStub = { ...ROUTE_FIXTURE };

  function makeMapWithRoute(): MapDetail {
    return { ...makeMapDetail(), routes: [ROUTE_FIXTURE] };
  }

  // Set up api mock to handle: map detail, layers, entries, route mutations
  function setupEditorApi(mapData?: MapDetail) {
    vi.mocked(api).mockImplementation(async (path: string) => {
      if (typeof path !== 'string') return null as never;
      if (path.includes('/map-layers')) return [] as never;
      // Universe entries list (/universes/:uid/entries)
      if (path.match(/\/entries$/) || path.match(/\/entries\?/)) return [] as never;
      // Route mutation calls (/routes/:routeId)
      if (path.includes('/routes/')) return routeStub as never;
      // Default: map detail
      return (mapData ?? makeMapWithRoute()) as never;
    });
  }

  // Render editor (non-share) with a fresh QueryClient
  function renderEditorMode() {
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    return render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={[`/universes/${EDITOR_UID}/maps/${MAP_ID}`]}>
          <Routes>
            <Route path="/universes/:uid/maps/:mid" element={<MapEditor />} />
            <Route
              path="/universes/:uid/entries/:entryId"
              element={<div data-testid="entry-page" />}
            />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
  }

  // Helper: wait for canvas, then open the route context menu via stub button
  async function openRouteContextMenu() {
    await screen.findByTestId('map-canvas-stub');
    const ctxBtn = await screen.findByTestId(`route-ctx-${ROUTE_1_ID}`);
    fireEvent.click(ctxBtn);
    return screen.findByRole('menu', { name: /route actions/i });
  }

  beforeEach(() => {
    // Switch to editor mode for these tests
    _shareMode = false;
    _shareToken = null;
    vi.mocked(api).mockReset();
  });

  afterEach(() => {
    // Restore share mode defaults so sibling describe blocks are unaffected
    _shareMode = true;
    _shareToken = 'test-share-token';
    vi.clearAllMocks();
  });

  it('R1: lineStyle toggle fires updateRoute PATCH with dashed lineStyle', async () => {
    setupEditorApi();
    renderEditorMode();
    await openRouteContextMenu();

    // For a 'solid' route, the toggle button text is "Dashed line"
    const lineStyleBtn = screen.getByRole('menuitem', { name: /dashed line/i });
    fireEvent.click(lineStyleBtn);

    await waitFor(() => {
      const patchCall = vi.mocked(api).mock.calls.find(([path, init]) =>
        typeof path === 'string' &&
        path.includes(`/routes/${ROUTE_1_ID}`) &&
        (init as RequestInit)?.method === 'PATCH' &&
        ((init as RequestInit)?.body as string)?.includes('"lineStyle":"dashed"'),
      );
      expect(patchCall).toBeDefined();
    });
  });

  it('R2: width preset fires updateRoute PATCH with width 2 (Thin)', async () => {
    setupEditorApi();
    renderEditorMode();
    await openRouteContextMenu();

    const thinBtn = screen.getByRole('menuitem', { name: /^Thin$/i });
    fireEvent.click(thinBtn);

    await waitFor(() => {
      const patchCall = vi.mocked(api).mock.calls.find(([path, init]) =>
        typeof path === 'string' &&
        path.includes(`/routes/${ROUTE_1_ID}`) &&
        (init as RequestInit)?.method === 'PATCH' &&
        ((init as RequestInit)?.body as string)?.includes('"width":2'),
      );
      expect(patchCall).toBeDefined();
    });
  });

  it('R3: showArrow toggle fires updateRoute PATCH with showArrow true', async () => {
    setupEditorApi();
    renderEditorMode();
    await openRouteContextMenu();

    // For showArrow=false, the toggle button says "Add arrow"
    const arrowBtn = screen.getByRole('menuitem', { name: /add arrow/i });
    fireEvent.click(arrowBtn);

    await waitFor(() => {
      const patchCall = vi.mocked(api).mock.calls.find(([path, init]) =>
        typeof path === 'string' &&
        path.includes(`/routes/${ROUTE_1_ID}`) &&
        (init as RequestInit)?.method === 'PATCH' &&
        ((init as RequestInit)?.body as string)?.includes('"showArrow":true'),
      );
      expect(patchCall).toBeDefined();
    });
  });

  it('R4: rename dialog fires updateRoute PATCH with new name', async () => {
    setupEditorApi();
    renderEditorMode();
    await openRouteContextMenu();

    // Click "Rename..." — context menu closes, rename dialog opens
    fireEvent.click(screen.getByRole('menuitem', { name: /rename/i }));

    const dialog = await screen.findByRole('dialog', { name: /rename route/i });
    const input = dialog.querySelector('input') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'New Route Name' } });

    // Click Save
    fireEvent.click(screen.getByRole('button', { name: /save/i }));

    await waitFor(() => {
      const patchCall = vi.mocked(api).mock.calls.find(([path, init]) =>
        typeof path === 'string' &&
        path.includes(`/routes/${ROUTE_1_ID}`) &&
        (init as RequestInit)?.method === 'PATCH' &&
        ((init as RequestInit)?.body as string)?.includes('"name":"New Route Name"'),
      );
      expect(patchCall).toBeDefined();
    });
  });

  it('R5: relink picker fires updateRoute PATCH with new entryId', async () => {
    setupEditorApi();
    renderEditorMode();
    await openRouteContextMenu();

    // Click "Change entry..." — picker opens
    fireEvent.click(screen.getByRole('menuitem', { name: /change entry/i }));

    const pickerBtn = await screen.findByTestId('add-entries-picker-select');
    fireEvent.click(pickerBtn);

    await waitFor(() => {
      const patchCall = vi.mocked(api).mock.calls.find(([path, init]) =>
        typeof path === 'string' &&
        path.includes(`/routes/${ROUTE_1_ID}`) &&
        (init as RequestInit)?.method === 'PATCH' &&
        ((init as RequestInit)?.body as string)?.includes('"entryId":"entry-new-uuid"'),
      );
      expect(patchCall).toBeDefined();
    });
  });

  it('R6: delete-confirm fires deleteRoute DELETE', async () => {
    setupEditorApi();
    renderEditorMode();
    await openRouteContextMenu();

    // Click "Delete route" — ConfirmDialog opens
    fireEvent.click(screen.getByRole('menuitem', { name: /delete route/i }));

    const confirmBtn = await screen.findByTestId('confirm-dialog-confirm');
    fireEvent.click(confirmBtn);

    await waitFor(() => {
      const deleteCall = vi.mocked(api).mock.calls.find(([path, init]) =>
        typeof path === 'string' &&
        path.includes(`/routes/${ROUTE_1_ID}`) &&
        (init as RequestInit)?.method === 'DELETE',
      );
      expect(deleteCall).toBeDefined();
    });
  });

  it('R7: left-click on linked route navigates to editor entry path', async () => {
    setupEditorApi();
    renderEditorMode();
    await screen.findByTestId('map-canvas-stub');

    const clickBtn = await screen.findByTestId(`route-click-${ROUTE_1_ID}`);
    fireEvent.click(clickBtn);

    // Navigator must render the entry page at /universes/:uid/entries/:entryId
    await waitFor(() => {
      expect(screen.getByTestId('entry-page')).toBeInTheDocument();
    });
  });

  it('R8: left-click on linked route navigates to share entry path in share mode', async () => {
    // Override to share mode for this test (afterEach restores)
    _shareMode = true;
    _shareToken = 'test-share-token';

    vi.mocked(api).mockImplementation(async (path: string) => {
      if (path.includes('/map-layers')) return [] as never;
      if (path.includes('/entries')) return [] as never;
      return makeMapWithRoute() as never;
    });

    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={[`/share/test-share-token/maps/${MAP_ID}`]}>
          <Routes>
            <Route path="/share/:token/maps/:mid" element={<MapEditor />} />
            <Route
              path="/share/:token/entries/:entryId"
              element={<div data-testid="share-entry-page" />}
            />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );

    await screen.findByTestId('map-canvas-stub');
    const clickBtn = await screen.findByTestId(`route-click-${ROUTE_1_ID}`);
    fireEvent.click(clickBtn);

    await waitFor(() => {
      expect(screen.getByTestId('share-entry-page')).toBeInTheDocument();
    });
  });

  it('R9: share mode suppresses route context menu (T-51-13)', async () => {
    // Override to share mode for this test (afterEach restores)
    _shareMode = true;
    _shareToken = 'test-share-token';

    vi.mocked(api).mockImplementation(async (path: string) => {
      if (path.includes('/map-layers')) return [] as never;
      if (path.includes('/entries')) return [] as never;
      return makeMapWithRoute() as never;
    });

    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={[`/share/test-share-token/maps/${MAP_ID}`]}>
          <Routes>
            <Route path="/share/:token/maps/:mid" element={<MapEditor />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );

    await screen.findByTestId('map-canvas-stub');

    // In share mode, the MapCanvas prop onRouteContextMenu is a no-op () => {}.
    // Clicking the stub's context-menu trigger calls that no-op → routeContextMenu stays null.
    const ctxBtn = await screen.findByTestId(`route-ctx-${ROUTE_1_ID}`);
    fireEvent.click(ctxBtn);

    // Route context menu div must NOT appear (T-51-13 gate)
    expect(screen.queryByRole('menu', { name: /route actions/i })).not.toBeInTheDocument();
  });
});

// ── BUG-2 / BUG-3 regression tests (Plan 07 UAT fix) ────────────────────────────
//
// BUG-2: Multiple hint banners could stack (each positioned at the same absolute
//   spot) when two draw modes were simultaneously active. Fix: compute ONE banner
//   string and render at most one element (data-testid="map-hint-banner").
//
// BUG-3: The empty-state CTA button ("Add pin") was a pointer-events-auto card
//   in the map center. While drawing a route, clicking a vertex location that
//   overlapped the card set addPinMode=true without appending a vertex, making
//   the canvas click appear to "not register". Fix: hide the CTA whenever any
//   draw mode is active.

describe('MapEditor banner dedup + CTA draw-mode guard (BUG-2/BUG-3, Plan 07)', () => {
  const EDITOR_UID_B = 'test-universe-uuid';

  // A map with no content so the empty-state CTA shows.
  function makeEmptyMap(): MapDetail {
    return { ...makeMapDetail(), terrainAreas: [], pins: [], regions: [], routes: [] };
  }

  function setupEmptyMapApi() {
    vi.mocked(api).mockImplementation(async (path: string) => {
      if (typeof path !== 'string') return null as never;
      if (path.includes('/map-layers')) return [] as never;
      if (path.match(/\/entries$/) || path.match(/\/entries\?/)) return [] as never;
      return makeEmptyMap() as never;
    });
  }

  function renderEditorEmpty() {
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    return render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={[`/universes/${EDITOR_UID_B}/maps/${MAP_ID}`]}>
          <Routes>
            <Route path="/universes/:uid/maps/:mid" element={<MapEditor />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
  }

  beforeEach(() => {
    _shareMode = false;
    _shareToken = null;
    vi.mocked(api).mockReset();
  });

  afterEach(() => {
    // Restore share mode so sibling describe blocks are unaffected.
    _shareMode = true;
    _shareToken = 'test-share-token';
    vi.clearAllMocks();
  });

  it('B1: exactly ONE hint banner renders when drawRouteMode is armed', async () => {
    setupEmptyMapApi();
    renderEditorEmpty();
    await screen.findByTestId('map-canvas-stub');

    // Arm route draw mode via the toolbar toggle stub.
    const routeToggle = await screen.findByTestId('toolbar-draw-route-toggle');
    fireEvent.click(routeToggle);

    // Exactly ONE hint banner must appear — the banner dedup fix eliminates multiple stacked divs.
    await waitFor(() => {
      const banners = screen.getAllByTestId('map-hint-banner');
      expect(banners, 'must render exactly one banner when drawRouteMode is active').toHaveLength(1);
    });
  });

  it('B2: empty-state CTA container is hidden while any draw mode is active (BUG-3 root cause fix)', async () => {
    setupEmptyMapApi();
    renderEditorEmpty();
    await screen.findByTestId('map-canvas-stub');

    // CTA container must be visible initially (no draw modes, no map items).
    // Uses data-testid="map-empty-state-cta" — the pointer-events-auto wrapper is always
    // in the DOM when the condition is satisfied, even though EmptyState itself is mocked to null.
    await waitFor(() => {
      expect(screen.queryByTestId('map-empty-state-cta')).not.toBeNull();
    });

    // Arm route draw mode.
    const routeToggle = await screen.findByTestId('toolbar-draw-route-toggle');
    fireEvent.click(routeToggle);

    // CTA container must disappear — its pointer-events-auto card was the root cause of BUG-3
    // (it intercepted canvas clicks in the map center, preventing vertex placement in route mode).
    await waitFor(() => {
      expect(screen.queryByTestId('map-empty-state-cta')).toBeNull();
    });
  });
});
