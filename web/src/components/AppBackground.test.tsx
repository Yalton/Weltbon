import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, act } from '@testing-library/react';

// --- Mock createCanvas2dRenderer ---
const mockRenderer = {
  init: vi.fn(),
  step: vi.fn(),
  draw: vi.fn(),
  resize: vi.fn(),
  setTheme: vi.fn(),
  setEntries: vi.fn(),
  dispose: vi.fn(),
  getBodies: vi.fn(() => []),
};

vi.mock('../lib/sim/canvas2dRenderer', () => ({
  createCanvas2dRenderer: vi.fn(() => mockRenderer),
}));

// --- Mock rAF/cAF ---
let rafCallbacks: Map<number, FrameRequestCallback> = new Map();
let rafIdCounter = 0;
let cafCalledWith: number[] = [];

// --- matchMedia mock factory ---
function makeMqMock(matches: boolean) {
  const listeners: Array<(e: { matches: boolean }) => void> = [];
  return {
    matches,
    addListener: vi.fn((cb: (e: { matches: boolean }) => void) => listeners.push(cb)),
    removeListener: vi.fn((cb: (e: { matches: boolean }) => void) => {
      const idx = listeners.indexOf(cb);
      if (idx !== -1) listeners.splice(idx, 1);
    }),
    addEventListener: vi.fn((ev: string, cb: (e: { matches: boolean }) => void) => listeners.push(cb)),
    removeEventListener: vi.fn((ev: string, cb: (e: { matches: boolean }) => void) => {
      const idx = listeners.indexOf(cb);
      if (idx !== -1) listeners.splice(idx, 1);
    }),
    _triggerChange(newMatches: boolean) {
      listeners.forEach(cb => cb({ matches: newMatches }));
    },
  };
}

// Import after mocks
import { AppBackground } from './AppBackground';

describe('AppBackground', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    rafCallbacks = new Map();
    rafIdCounter = 0;
    cafCalledWith = [];

    // Mock rAF/cAF
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      const id = ++rafIdCounter;
      rafCallbacks.set(id, cb);
      return id;
    });
    vi.stubGlobal('cancelAnimationFrame', (id: number) => {
      cafCalledWith.push(id);
      rafCallbacks.delete(id);
    });

    // Mock MutationObserver
    vi.stubGlobal('MutationObserver', vi.fn(() => ({
      observe: vi.fn(),
      disconnect: vi.fn(),
    })));

    // Stub window.innerWidth/Height
    Object.defineProperty(window, 'innerWidth', { value: 1280, configurable: true });
    Object.defineProperty(window, 'innerHeight', { value: 720, configurable: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders a canvas with aria-hidden="true" and role="presentation"', () => {
    vi.stubGlobal('matchMedia', vi.fn(() => makeMqMock(false)));
    const { container } = render(<AppBackground />);
    const canvas = container.querySelector('canvas');
    expect(canvas).not.toBeNull();
    expect(canvas!.getAttribute('aria-hidden')).toBe('true');
    expect(canvas!.getAttribute('role')).toBe('presentation');
  });

  it('canvas has pointer-events-none and fixed inset-0 -z-10 classes', () => {
    vi.stubGlobal('matchMedia', vi.fn(() => makeMqMock(false)));
    const { container } = render(<AppBackground />);
    const canvas = container.querySelector('canvas');
    expect(canvas!.className).toContain('pointer-events-none');
    expect(canvas!.className).toContain('fixed');
    expect(canvas!.className).toContain('inset-0');
    expect(canvas!.className).toContain('-z-10');
  });

  it('does NOT start rAF when prefers-reduced-motion is reduce', () => {
    vi.stubGlobal('matchMedia', vi.fn(() => makeMqMock(true)));
    render(<AppBackground />);
    // rAF should not have been called after mount (or called but immediately cancelled)
    // The key assertion: after mount with reducedMotion=true, no pending rAF callbacks
    expect(rafCallbacks.size).toBe(0);
  });

  it('calls renderer.draw() exactly once under reduced-motion (static frame)', () => {
    vi.stubGlobal('matchMedia', vi.fn(() => makeMqMock(true)));
    render(<AppBackground />);
    expect(mockRenderer.draw).toHaveBeenCalledTimes(1);
  });

  it('starts rAF when prefers-reduced-motion is false', () => {
    vi.stubGlobal('matchMedia', vi.fn(() => makeMqMock(false)));
    render(<AppBackground />);
    expect(rafCallbacks.size).toBeGreaterThan(0);
  });

  it('registers visibilitychange listener on document', () => {
    const addEventSpy = vi.spyOn(document, 'addEventListener');
    vi.stubGlobal('matchMedia', vi.fn(() => makeMqMock(false)));
    render(<AppBackground />);
    expect(addEventSpy).toHaveBeenCalledWith('visibilitychange', expect.any(Function));
  });

  it('cancels rAF on unmount and calls renderer.dispose()', () => {
    vi.stubGlobal('matchMedia', vi.fn(() => makeMqMock(false)));
    const { unmount } = render(<AppBackground />);
    act(() => {
      unmount();
    });
    expect(mockRenderer.dispose).toHaveBeenCalled();
    // cAF should have been called at some point
    expect(cafCalledWith.length).toBeGreaterThan(0);
  });

  it('calls renderer.init() on mount with isDark reflecting documentElement class', () => {
    vi.stubGlobal('matchMedia', vi.fn(() => makeMqMock(false)));
    render(<AppBackground />);
    expect(mockRenderer.init).toHaveBeenCalledTimes(1);
    const [, isDark] = mockRenderer.init.mock.calls[0];
    // documentElement doesn't have 'dark' class in test env by default
    expect(typeof isDark).toBe('boolean');
  });

  it('catches renderer.init() error and does not throw to React tree', () => {
    mockRenderer.init.mockImplementationOnce(() => {
      throw new Error('canvas context unavailable');
    });
    vi.stubGlobal('matchMedia', vi.fn(() => makeMqMock(false)));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(() => render(<AppBackground />)).not.toThrow();
    warnSpy.mockRestore();
  });
});
