
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { createElement } from 'react';

// Per-file mock — prevents blast radius onto sibling tests.
vi.mock('../api/client', () => ({ api: vi.fn() }));
import { api } from '../api/client';

// These imports will FAIL (RED) before the mutations are exported.
import {
  useTogglePinSecret,
  useToggleRegionSecret,
  useToggleRouteSecret,
} from './useMap';
import { useToggleLayerSecret } from './useMapLayers';

const UNIVERSE_ID = 'uni-test-uuid';
const MAP_ID = 'map-test-uuid';
const PIN_ID = 'pin-test-uuid';
const REGION_ID = 'region-test-uuid';
const ROUTE_ID = 'route-test-uuid';
const LAYER_ID = 'layer-test-uuid';

function makeQueryClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
}

function wrapperFactory(qc: QueryClient) {
  return ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client: qc }, children);
}

beforeEach(() => {
  vi.mocked(api).mockReset();
  vi.mocked(api).mockResolvedValue({} as never);
});

// ── useTogglePinSecret ─────────────────────────────��──────────────────────��─────

describe('useTogglePinSecret', () => {
  it('PATCHes /pins/:pinId/style with { secret: true }', async () => {
    const qc = makeQueryClient();
    const { result } = renderHook(
      () => useTogglePinSecret(UNIVERSE_ID, MAP_ID),
      { wrapper: wrapperFactory(qc) },
    );
    await act(async () => {
      await result.current.mutateAsync({ pinId: PIN_ID, secret: true });
    });
    expect(vi.mocked(api)).toHaveBeenCalledWith(
      `/universes/${UNIVERSE_ID}/maps/${MAP_ID}/pins/${PIN_ID}/style`,
      expect.objectContaining({
        method: 'PATCH',
        body: JSON.stringify({ secret: true }),
      }),
    );
  });

  it('PATCHes /pins/:pinId/style with { secret: false }', async () => {
    const qc = makeQueryClient();
    const { result } = renderHook(
      () => useTogglePinSecret(UNIVERSE_ID, MAP_ID),
      { wrapper: wrapperFactory(qc) },
    );
    await act(async () => {
      await result.current.mutateAsync({ pinId: PIN_ID, secret: false });
    });
    expect(vi.mocked(api)).toHaveBeenCalledWith(
      `/universes/${UNIVERSE_ID}/maps/${MAP_ID}/pins/${PIN_ID}/style`,
      expect.objectContaining({
        method: 'PATCH',
        body: JSON.stringify({ secret: false }),
      }),
    );
  });

  it('invalidates [\'map\', universeId, mapId] on success — no new segments', async () => {
    const qc = makeQueryClient();
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');
    const { result } = renderHook(
      () => useTogglePinSecret(UNIVERSE_ID, MAP_ID),
      { wrapper: wrapperFactory(qc) },
    );
    await act(async () => {
      await result.current.mutateAsync({ pinId: PIN_ID, secret: true });
    });
    expect(invalidateSpy).toHaveBeenCalledWith(
      expect.objectContaining({ queryKey: ['map', UNIVERSE_ID, MAP_ID] }),
    );
    // Guard: must NOT have been called with a 4-segment key (blast-radius landmine).
    const calls = invalidateSpy.mock.calls;
    const hasNewSegment = calls.some(
      ([arg]) =>
        Array.isArray((arg as { queryKey?: unknown[] }).queryKey) &&
        (arg as { queryKey: unknown[] }).queryKey.length > 3,
    );
    expect(hasNewSegment).toBe(false);
  });
});

// ── useToggleRegionSecret ───────────────────────────────────────────────────────

describe('useToggleRegionSecret', () => {
  it('PATCHes /regions/:regionId with { secret: true }', async () => {
    const qc = makeQueryClient();
    const { result } = renderHook(
      () => useToggleRegionSecret(UNIVERSE_ID, MAP_ID),
      { wrapper: wrapperFactory(qc) },
    );
    await act(async () => {
      await result.current.mutateAsync({ regionId: REGION_ID, secret: true });
    });
    expect(vi.mocked(api)).toHaveBeenCalledWith(
      `/universes/${UNIVERSE_ID}/maps/${MAP_ID}/regions/${REGION_ID}`,
      expect.objectContaining({
        method: 'PATCH',
        body: JSON.stringify({ secret: true }),
      }),
    );
  });

  it('invalidates [\'map\', universeId, mapId] on success', async () => {
    const qc = makeQueryClient();
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');
    const { result } = renderHook(
      () => useToggleRegionSecret(UNIVERSE_ID, MAP_ID),
      { wrapper: wrapperFactory(qc) },
    );
    await act(async () => {
      await result.current.mutateAsync({ regionId: REGION_ID, secret: true });
    });
    expect(invalidateSpy).toHaveBeenCalledWith(
      expect.objectContaining({ queryKey: ['map', UNIVERSE_ID, MAP_ID] }),
    );
  });
});

// ── useToggleRouteSecret ────────────────────────────────────────────────────────

describe('useToggleRouteSecret', () => {
  it('PATCHes /routes/:routeId with { secret: true }', async () => {
    const qc = makeQueryClient();
    const { result } = renderHook(
      () => useToggleRouteSecret(UNIVERSE_ID, MAP_ID),
      { wrapper: wrapperFactory(qc) },
    );
    await act(async () => {
      await result.current.mutateAsync({ routeId: ROUTE_ID, secret: true });
    });
    expect(vi.mocked(api)).toHaveBeenCalledWith(
      `/universes/${UNIVERSE_ID}/maps/${MAP_ID}/routes/${ROUTE_ID}`,
      expect.objectContaining({
        method: 'PATCH',
        body: JSON.stringify({ secret: true }),
      }),
    );
  });

  it('invalidates [\'map\', universeId, mapId] on success', async () => {
    const qc = makeQueryClient();
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');
    const { result } = renderHook(
      () => useToggleRouteSecret(UNIVERSE_ID, MAP_ID),
      { wrapper: wrapperFactory(qc) },
    );
    await act(async () => {
      await result.current.mutateAsync({ routeId: ROUTE_ID, secret: true });
    });
    expect(invalidateSpy).toHaveBeenCalledWith(
      expect.objectContaining({ queryKey: ['map', UNIVERSE_ID, MAP_ID] }),
    );
  });
});

// ── useToggleLayerSecret ────────────────────────────────────────────────────────

describe('useToggleLayerSecret', () => {
  it('PATCHes /map-layers/:layerId with { secret: true }', async () => {
    const qc = makeQueryClient();
    const { result } = renderHook(
      () => useToggleLayerSecret(UNIVERSE_ID),
      { wrapper: wrapperFactory(qc) },
    );
    await act(async () => {
      await result.current.mutateAsync({ layerId: LAYER_ID, secret: true });
    });
    expect(vi.mocked(api)).toHaveBeenCalledWith(
      `/universes/${UNIVERSE_ID}/map-layers/${LAYER_ID}`,
      expect.objectContaining({
        method: 'PATCH',
        body: JSON.stringify({ secret: true }),
      }),
    );
  });

  it('invalidates [\'map-layers\', universeId] on success — NOT map key', async () => {
    const qc = makeQueryClient();
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');
    const { result } = renderHook(
      () => useToggleLayerSecret(UNIVERSE_ID),
      { wrapper: wrapperFactory(qc) },
    );
    await act(async () => {
      await result.current.mutateAsync({ layerId: LAYER_ID, secret: false });
    });
    expect(invalidateSpy).toHaveBeenCalledWith(
      expect.objectContaining({ queryKey: ['map-layers', UNIVERSE_ID] }),
    );
    // Guard: must NOT have invalidated the ['map', ...] key.
    const calls = invalidateSpy.mock.calls;
    const invalidatedMapKey = calls.some(
      ([arg]) =>
        Array.isArray((arg as { queryKey?: unknown[] }).queryKey) &&
        (arg as { queryKey: unknown[] }).queryKey[0] === 'map',
    );
    expect(invalidatedMapKey).toBe(false);
  });
});
