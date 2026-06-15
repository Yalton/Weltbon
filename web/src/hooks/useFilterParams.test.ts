import { describe, it, expect } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { createElement } from 'react';
import type { ReactNode } from 'react';
import { MemoryRouter, useSearchParams } from 'react-router-dom';
import { useFilterParams } from './useFilterParams';
import { buildEntriesQueryString } from './useFilteredEntries';
import type { EntryFilters } from './useFilterParams';

/**
 * Render useFilterParams inside a MemoryRouter so the URL search params are the
 * single source of truth. We also surface useSearchParams so a test can read the
 * resulting raw query string after an update.
 */
function renderFilterParams(initialEntry = '/entries') {
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(MemoryRouter, { initialEntries: [initialEntry] }, children);

  return renderHook(
    () => {
      const [filters, update] = useFilterParams();
      const [params] = useSearchParams();
      return { filters, update, params };
    },
    { wrapper },
  );
}

describe('useFilterParams — wip three-state', () => {
  it('decodes ?wip=true → true, ?wip=false → false, absent → null', () => {
    expect(renderFilterParams('/entries?wip=true').result.current.filters.wip).toBe(true);
    expect(renderFilterParams('/entries?wip=false').result.current.filters.wip).toBe(false);
    expect(renderFilterParams('/entries').result.current.filters.wip).toBeNull();
  });

  it('round-trips wip: setting true then false then null updates the URL', () => {
    const { result } = renderFilterParams('/entries');

    act(() => result.current.update({ wip: true }));
    expect(result.current.params.get('wip')).toBe('true');
    expect(result.current.filters.wip).toBe(true);

    act(() => result.current.update({ wip: false }));
    expect(result.current.params.get('wip')).toBe('false');
    expect(result.current.filters.wip).toBe(false);

    act(() => result.current.update({ wip: null }));
    expect(result.current.params.has('wip')).toBe(false);
    expect(result.current.filters.wip).toBeNull();
  });
});

describe('useFilterParams — fieldFilters (dot-notation field.*)', () => {
  it('decodes ?field.X=Y into fieldFilters[X] = Y', () => {
    const { result } = renderFilterParams('/entries?field.Status=draft&field.Rank=3');
    expect(result.current.filters.fieldFilters).toEqual({ Status: 'draft', Rank: '3' });
  });

  it('encodes fieldFilters into field.{name} URL keys', () => {
    const { result } = renderFilterParams('/entries');
    act(() => result.current.update({ fieldFilters: { Status: 'draft' } }));
    expect(result.current.params.get('field.Status')).toBe('draft');
    expect(result.current.filters.fieldFilters).toEqual({ Status: 'draft' });
  });

  it('one chip per field — re-adding a chip on the SAME field replaces it (D-08 full-replace)', () => {
    const { result } = renderFilterParams('/entries?field.Status=draft');

    // Replacing the fieldFilters map with a new value for Status overwrites the
    // previous field.Status param (full-replace, not append).
    act(() => result.current.update({ fieldFilters: { Status: 'published' } }));

    // Only one field.Status value survives, and it is the new one.
    expect(result.current.params.getAll('field.Status')).toEqual(['published']);
    expect(result.current.filters.fieldFilters).toEqual({ Status: 'published' });
  });

  it('full-replace drops stale field.* keys not in the new map', () => {
    const { result } = renderFilterParams('/entries?field.Status=draft&field.Rank=3');
    act(() => result.current.update({ fieldFilters: { Status: 'final' } }));
    expect(result.current.params.has('field.Rank')).toBe(false);
    expect(result.current.filters.fieldFilters).toEqual({ Status: 'final' });
  });

  it('layers field + wip on top of q/type/tag/category as one unified query (D-08)', () => {
    const { result } = renderFilterParams('/entries?q=hi&type=place&tag=coast&category=cat-1');
    act(() => result.current.update({ wip: true, fieldFilters: { Status: 'draft' } }));

    expect(result.current.params.get('q')).toBe('hi');
    expect(result.current.params.get('type')).toBe('place');
    expect(result.current.params.get('tag')).toBe('coast');
    expect(result.current.params.get('category')).toBe('cat-1');
    expect(result.current.params.get('wip')).toBe('true');
    expect(result.current.params.get('field.Status')).toBe('draft');
  });
});

describe('buildEntriesQueryString — wip + field.* params', () => {
  const base: EntryFilters = {
    q: '',
    type: null,
    tags: [],
    category: null,
    wip: null,
    fieldFilters: {},
  };

  it('emits ?wip= only when wip is a boolean', () => {
    expect(buildEntriesQueryString({ ...base, wip: true })).toContain('wip=true');
    expect(buildEntriesQueryString({ ...base, wip: false })).toContain('wip=false');
    expect(buildEntriesQueryString({ ...base, wip: null })).not.toContain('wip');
  });

  it('emits ?field.{name}={value} for each fieldFilters entry', () => {
    const qs = buildEntriesQueryString({ ...base, fieldFilters: { Status: 'draft' } });
    // URLSearchParams encodes the dot-key; assert on the decoded form.
    expect(decodeURIComponent(qs)).toContain('field.Status=draft');
  });

  it('produces empty string for fully-empty filters', () => {
    expect(buildEntriesQueryString(base)).toBe('');
  });
});

describe('useFilteredEntries — cache-key regression guard', () => {
  // The v3.2 useFilteredEntries queryKey MUST keep the share-token segment
  // (['entries', universeId, filters, shareToken]); the 9b82f27 port lacked it.
  // We guard the source text so a future merge cannot silently regress the key.
  it('queryKey still includes shareToken in the source', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    // Resolve relative to this test file's directory (src/hooks).
    const src = fs.readFileSync(
      path.resolve(process.cwd(), 'src/hooks/useFilteredEntries.ts'),
      'utf8',
    );
    expect(src).toContain('getShareToken');
    expect(src).toMatch(/queryKey:\s*\['entries',\s*universeId,\s*filters,\s*shareToken\]/);
  });
});
