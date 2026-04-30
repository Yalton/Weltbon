/**
 * Tests for simSettings Zustand store.
 *
 * Covers:
 * - Default OFF when localStorage is empty or unavailable
 * - Hydration from existing localStorage value ('1' → true)
 * - Persistence on update (setShowEntriesAsBodies writes localStorage)
 * - Fallback behavior when localStorage throws (SSR / private mode)
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

// We need to test localStorage interactions — reset store between tests
// by re-importing after clearing module cache.

describe('simSettings store', () => {
  let getItemMock: ReturnType<typeof vi.fn>;
  let setItemMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    // Reset mocks before each test
    vi.resetModules();
    getItemMock = vi.fn().mockReturnValue(null);
    setItemMock = vi.fn();
    vi.stubGlobal('localStorage', {
      getItem: getItemMock,
      setItem: setItemMock,
      removeItem: vi.fn(),
      clear: vi.fn(),
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('defaults showEntriesAsBodies to false when localStorage returns null', async () => {
    getItemMock.mockReturnValue(null);
    const { useSimSettings } = await import('./simSettings');
    const state = useSimSettings.getState();
    expect(state.showEntriesAsBodies).toBe(false);
  });

  it("hydrates showEntriesAsBodies to true when localStorage returns '1'", async () => {
    getItemMock.mockReturnValue('1');
    const { useSimSettings } = await import('./simSettings');
    const state = useSimSettings.getState();
    expect(state.showEntriesAsBodies).toBe(true);
  });

  it("hydrates showEntriesAsBodies to false when localStorage returns '0'", async () => {
    getItemMock.mockReturnValue('0');
    const { useSimSettings } = await import('./simSettings');
    const state = useSimSettings.getState();
    expect(state.showEntriesAsBodies).toBe(false);
  });

  it('setShowEntriesAsBodies(true) updates state and writes "1" to localStorage', async () => {
    getItemMock.mockReturnValue(null);
    const { useSimSettings } = await import('./simSettings');
    useSimSettings.getState().setShowEntriesAsBodies(true);
    expect(useSimSettings.getState().showEntriesAsBodies).toBe(true);
    expect(setItemMock).toHaveBeenCalledWith('weltbon-show-entries-as-bodies', '1');
  });

  it('setShowEntriesAsBodies(false) updates state and writes "0" to localStorage', async () => {
    getItemMock.mockReturnValue('1');
    const { useSimSettings } = await import('./simSettings');
    useSimSettings.getState().setShowEntriesAsBodies(false);
    expect(useSimSettings.getState().showEntriesAsBodies).toBe(false);
    expect(setItemMock).toHaveBeenCalledWith('weltbon-show-entries-as-bodies', '0');
  });

  it('falls back to false without throwing when localStorage.getItem throws', async () => {
    vi.stubGlobal('localStorage', {
      getItem: vi.fn(() => { throw new Error('Private mode'); }),
      setItem: vi.fn(),
    });
    const { useSimSettings } = await import('./simSettings');
    const state = useSimSettings.getState();
    expect(state.showEntriesAsBodies).toBe(false);
  });

  it('does not throw when localStorage.setItem throws', async () => {
    getItemMock.mockReturnValue(null);
    setItemMock.mockImplementation(() => { throw new Error('Private mode'); });
    const { useSimSettings } = await import('./simSettings');
    // Should not throw
    expect(() => useSimSettings.getState().setShowEntriesAsBodies(true)).not.toThrow();
    // State still updates
    expect(useSimSettings.getState().showEntriesAsBodies).toBe(true);
  });
});
