import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useImportDraft } from './useImportDraft';
import type { IngestPreview, ReviewDecisions, SavedDraft } from '../types/ingestReview';

const emptyPreview: IngestPreview = {
  summary: {
    markdown_files_parsed: 0,
    non_markdown_files_skipped: 0,
    hidden_paths_filtered: 0,
    duplicate_titles_in_batch: 0,
    unresolved_wikilinks: 0,
  },
  entries: [],
  warnings: [],
};
const emptyDecisions: ReviewDecisions = {};

describe('useImportDraft', () => {
  beforeEach(() => {
    localStorage.clear();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it('initial draft is null and lastError is null when localStorage is empty', () => {
    const { result } = renderHook(() => useImportDraft('U1'));
    expect(result.current.draft).toBeNull();
    expect(result.current.lastError).toBeNull();
  });

  it('reads an existing draft from localStorage on mount (key: weltbon.import.${uid})', () => {
    const fixture: SavedDraft = {
      preview: emptyPreview,
      decisions: emptyDecisions,
      savedAt: '2026-05-02T00:00:00.000Z',
    };
    localStorage.setItem('weltbon.import.U1', JSON.stringify(fixture));

    const { result } = renderHook(() => useImportDraft('U1'));
    expect(result.current.draft).toEqual(fixture);
  });

  it('save() writes to localStorage with an ISO 8601 savedAt and updates the draft state', () => {
    const { result } = renderHook(() => useImportDraft('U1'));
    act(() => {
      result.current.save({ preview: emptyPreview, decisions: emptyDecisions });
    });

    const raw = localStorage.getItem('weltbon.import.U1');
    expect(raw).not.toBeNull();
    const parsed = JSON.parse(raw!) as SavedDraft;
    expect(parsed.preview).toEqual(emptyPreview);
    expect(parsed.decisions).toEqual(emptyDecisions);
    // ISO 8601: e.g. 2026-05-02T13:18:00.000Z
    expect(parsed.savedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);

    expect(result.current.draft).toEqual(parsed);
    expect(result.current.lastError).toBeNull();
  });

  it('clear() removes the localStorage slot and resets draft to null', () => {
    const fixture: SavedDraft = {
      preview: emptyPreview,
      decisions: emptyDecisions,
      savedAt: '2026-05-02T00:00:00.000Z',
    };
    localStorage.setItem('weltbon.import.U1', JSON.stringify(fixture));
    const { result } = renderHook(() => useImportDraft('U1'));
    expect(result.current.draft).toEqual(fixture);

    act(() => {
      result.current.clear();
    });

    expect(localStorage.getItem('weltbon.import.U1')).toBeNull();
    expect(result.current.draft).toBeNull();
    expect(result.current.lastError).toBeNull();
  });

  it('save() swallows QuotaExceededError and surfaces it on lastError without throwing', () => {
    const setItemSpy = vi
      .spyOn(Storage.prototype, 'setItem')
      .mockImplementation(() => {
        throw new Error('QuotaExceededError');
      });

    const { result } = renderHook(() => useImportDraft('U1'));
    expect(() => {
      act(() => {
        result.current.save({ preview: emptyPreview, decisions: emptyDecisions });
      });
    }).not.toThrow();

    expect(result.current.lastError).toContain('QuotaExceededError');
    expect(result.current.draft).toBeNull(); // not updated on failure
    setItemSpy.mockRestore();
  });

  it('a different universeId writes to a different localStorage key (no cross-talk)', () => {
    const { result: hookA } = renderHook(() => useImportDraft('U1'));
    const { result: hookB } = renderHook(() => useImportDraft('U2'));

    act(() => {
      hookA.current.save({ preview: emptyPreview, decisions: emptyDecisions });
    });

    expect(localStorage.getItem('weltbon.import.U1')).not.toBeNull();
    expect(localStorage.getItem('weltbon.import.U2')).toBeNull();
    expect(hookB.current.draft).toBeNull();
  });

  it('JSON parse failure on initial read returns null gracefully (no throw)', () => {
    localStorage.setItem('weltbon.import.U1', '{not valid json');
    expect(() => {
      renderHook(() => useImportDraft('U1'));
    }).not.toThrow();
    const { result } = renderHook(() => useImportDraft('U1'));
    expect(result.current.draft).toBeNull();
  });
});
