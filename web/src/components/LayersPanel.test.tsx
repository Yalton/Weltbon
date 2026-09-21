
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

// Per-file api client mock (same pattern as CategoryManageDialog.test.tsx)
vi.mock('../api/client', () => ({
  api: vi.fn(),
}));

// Mock the entire useMapLayers module so we control data without network calls.
vi.mock('../hooks/useMapLayers', () => ({
  useMapLayers: vi.fn(),
  useCreateMapLayer: vi.fn(() => ({ mutate: vi.fn(), isPending: false })),
  useUpdateMapLayer: vi.fn(() => ({ mutate: vi.fn(), isPending: false })),
  useDeleteMapLayer: vi.fn(() => ({ mutate: vi.fn(), isPending: false })),

  useToggleLayerSecret: vi.fn(() => ({ mutate: vi.fn(), isPending: false })),
  useCreateTerrainType: vi.fn(() => ({ mutate: vi.fn(), isPending: false })),
  useUpdateTerrainType: vi.fn(() => ({ mutate: vi.fn(), isPending: false })),
  useDeleteTerrainType: vi.fn(() => ({ mutate: vi.fn(), isPending: false })),
  useAddBiomesPreset: vi.fn(() => ({ mutate: vi.fn(), isPending: false })),
  useAddElevationPreset: vi.fn(() => ({ mutate: vi.fn(), isPending: false })),
}));

import { useMapLayers } from '../hooks/useMapLayers';
import { LayersPanel } from './LayersPanel';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function Wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

function renderPanel(overrides?: { visible?: boolean }) {
  return render(
    <LayersPanel
      universeId="u1"
      visible={overrides?.visible ?? true}
      onToggle={vi.fn()}
    />,
    { wrapper: Wrapper },
  );
}

// ─── Test data ────────────────────────────────────────────────────────────────

const ORDERED_LAYER = {
  id: 'layer-1',
  universeId: 'u1',
  name: 'Elevation',
  ordered: true,
  defaultOpacity: 0.6,
  sortOrder: 0,
  createdAt: '2026-06-19T00:00:00.000Z',
  secret: false,
  terrainTypes: [
    {
      id: 'type-1',
      layerId: 'layer-1',
      name: 'Lowlands',
      color: '#84cc16',
      label: '< 200 m',
      sortOrder: 0,
      createdAt: '2026-06-19T00:00:00.000Z',
    },
    {
      id: 'type-2',
      layerId: 'layer-1',
      name: 'Hills',
      color: '#eab308',
      label: '200–600 m',
      sortOrder: 1,
      createdAt: '2026-06-19T00:00:00.000Z',
    },
    {
      id: 'type-3',
      layerId: 'layer-1',
      name: 'Highlands',
      color: '#d97706',
      label: '600–1500 m',
      sortOrder: 2,
      createdAt: '2026-06-19T00:00:00.000Z',
    },
  ],
};

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('LayersPanel', () => {
  beforeEach(() => {
    // Default: return empty layer list
    vi.mocked(useMapLayers).mockReturnValue({ data: [] } as never);
  });

  it('Test 1 — renders the world-wide scope banner with exact approved copy', () => {
    renderPanel();

    const banner = screen.getByRole('note');
    expect(banner).toBeInTheDocument();
    expect(banner.textContent).toBe(
      'World-wide — changes apply to all maps in this universe',
    );
  });

  it('Test 2 — when no layers exist, both preset buttons render', () => {
    vi.mocked(useMapLayers).mockReturnValue({ data: [] } as never);
    renderPanel();

    expect(
      screen.getByRole('button', { name: /add starter biomes/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /add starter elevation/i }),
    ).toBeInTheDocument();
  });

  it('Test 3 — ordered layer with 3 bands: first up-arrow aria-disabled=true, last down-arrow aria-disabled=true', () => {
    vi.mocked(useMapLayers).mockReturnValue({
      data: [ORDERED_LAYER],
    } as never);

    renderPanel();

    // Expand the layer to render terrain types (click the expand chevron)
    const expandBtn = screen.getByRole('button', {
      name: /expand elevation/i,
    });
    fireEvent.click(expandBtn);

    // First band (Lowlands) up-arrow should be aria-disabled
    const upArrows = screen.getAllByRole('button', { name: /move .+ up/i });
    expect(upArrows[0]).toHaveAttribute('aria-disabled', 'true');

    // Last band (Highlands) down-arrow should be aria-disabled
    const downArrows = screen.getAllByRole('button', { name: /move .+ down/i });
    expect(downArrows[downArrows.length - 1]).toHaveAttribute('aria-disabled', 'true');
  });

  it('Test 4 — panel root has role="region" aria-label="Layers panel"', () => {
    renderPanel();

    const panel = screen.getByRole('region', { name: /layers panel/i });
    expect(panel).toBeInTheDocument();
  });
});
