/**
 * Tests for the wip (three-state) and fieldFilters (Record<string,string>)
 * extensions to useFilterParams and buildEntriesQueryString.
 */
import { describe, it, expect } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import {
  MemoryRouter,
  Route,
  Routes,
} from 'react-router-dom';
import type { ReactNode } from 'react';
import { createElement } from 'react';
import { useFilterParams } from './useFilterParams';
import { buildEntriesQueryString } from './useFilteredEntries';

// ---------------------------------------------------------------------------
// Helper: render useFilterParams inside a MemoryRouter with an initial search string
// ---------------------------------------------------------------------------
function makeWrapper(initialSearch = '') {
  return function Wrapper({ children }: { children: ReactNode }) {
    return createElement(
      MemoryRouter,
      { initialEntries: [`/${initialSearch ? '?' + initialSearch : ''}`] },
      createElement(
        Routes,
        null,
        createElement(Route, { path: '/', element: children as React.ReactElement })
      )
    );
  };
}

// ---------------------------------------------------------------------------
// wip three-state projection
// ---------------------------------------------------------------------------
describe('useFilterParams — wip projection', () => {
  it('projects ?wip=true to filters.wip === true', () => {
    const { result } = renderHook(() => useFilterParams(), {
      wrapper: makeWrapper('wip=true'),
    });
    expect(result.current[0].wip).toBe(true);
  });

  it('projects ?wip=false to filters.wip === false', () => {
    const { result } = renderHook(() => useFilterParams(), {
      wrapper: makeWrapper('wip=false'),
    });
    expect(result.current[0].wip).toBe(false);
  });

  it('projects no wip param to filters.wip === null', () => {
    const { result } = renderHook(() => useFilterParams(), {
      wrapper: makeWrapper(''),
    });
    expect(result.current[0].wip).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// wip encoding via update()
// ---------------------------------------------------------------------------
describe('useFilterParams — wip update', () => {
  it('update({ wip: true }) sets ?wip=true in the URL', () => {
    const { result } = renderHook(() => useFilterParams(), {
      wrapper: makeWrapper(''),
    });
    act(() => {
      result.current[1]({ wip: true });
    });
    expect(result.current[0].wip).toBe(true);
  });

  it('update({ wip: false }) sets ?wip=false in the URL', () => {
    const { result } = renderHook(() => useFilterParams(), {
      wrapper: makeWrapper(''),
    });
    act(() => {
      result.current[1]({ wip: false });
    });
    expect(result.current[0].wip).toBe(false);
  });

  it('update({ wip: null }) deletes the wip param', () => {
    const { result } = renderHook(() => useFilterParams(), {
      wrapper: makeWrapper('wip=true'),
    });
    act(() => {
      result.current[1]({ wip: null });
    });
    expect(result.current[0].wip).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// fieldFilters projection
// ---------------------------------------------------------------------------
describe('useFilterParams — fieldFilters projection', () => {
  it('projects ?field.Region=North&field.Era=First to fieldFilters { Region: "North", Era: "First" }', () => {
    const { result } = renderHook(() => useFilterParams(), {
      wrapper: makeWrapper('field.Region=North&field.Era=First'),
    });
    expect(result.current[0].fieldFilters).toEqual({ Region: 'North', Era: 'First' });
  });

  it('projects no field.* params to an empty fieldFilters object', () => {
    const { result } = renderHook(() => useFilterParams(), {
      wrapper: makeWrapper(''),
    });
    expect(result.current[0].fieldFilters).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// fieldFilters encoding via update()
// ---------------------------------------------------------------------------
describe('useFilterParams — fieldFilters update', () => {
  it('update({ fieldFilters: { Region: "North" } }) writes ?field.Region=North', () => {
    const { result } = renderHook(() => useFilterParams(), {
      wrapper: makeWrapper(''),
    });
    act(() => {
      result.current[1]({ fieldFilters: { Region: 'North' } });
    });
    expect(result.current[0].fieldFilters).toEqual({ Region: 'North' });
  });

  it('update({ fieldFilters: { Region: "North" } }) clears prior field.* params', () => {
    const { result } = renderHook(() => useFilterParams(), {
      wrapper: makeWrapper('field.Era=First&field.Region=South'),
    });
    act(() => {
      result.current[1]({ fieldFilters: { Region: 'North' } });
    });
    // Only Region=North should remain; Era should be gone
    expect(result.current[0].fieldFilters).toEqual({ Region: 'North' });
  });

  it('update({ fieldFilters: {} }) removes all field.* params', () => {
    const { result } = renderHook(() => useFilterParams(), {
      wrapper: makeWrapper('field.Era=First'),
    });
    act(() => {
      result.current[1]({ fieldFilters: {} });
    });
    expect(result.current[0].fieldFilters).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// buildEntriesQueryString — wip + fieldFilters
// ---------------------------------------------------------------------------
describe('buildEntriesQueryString — wip and fieldFilters params', () => {
  const baseFilters = {
    q: '',
    type: null,
    tags: [],
    category: null,
  };

  it('includes ?wip=true when wip is true', () => {
    const qs = buildEntriesQueryString({ ...baseFilters, wip: true, fieldFilters: {} });
    expect(qs).toContain('wip=true');
  });

  it('includes ?wip=false when wip is false', () => {
    const qs = buildEntriesQueryString({ ...baseFilters, wip: false, fieldFilters: {} });
    expect(qs).toContain('wip=false');
  });

  it('omits wip param when wip is null', () => {
    const qs = buildEntriesQueryString({ ...baseFilters, wip: null, fieldFilters: {} });
    expect(qs).not.toContain('wip');
  });

  it('includes field.* params for each entry in fieldFilters', () => {
    const qs = buildEntriesQueryString({
      ...baseFilters,
      wip: null,
      fieldFilters: { Region: 'North', Era: 'First' },
    });
    expect(qs).toContain('field.Region=North');
    expect(qs).toContain('field.Era=First');
  });

  it('emits no field.* params when fieldFilters is empty', () => {
    const qs = buildEntriesQueryString({ ...baseFilters, wip: null, fieldFilters: {} });
    expect(qs).not.toContain('field.');
  });
});
