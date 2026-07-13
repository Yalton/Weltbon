import { afterEach, describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import { select } from 'd3-selection';
import { TimelineCanvas, type TimelineCanvasProps } from './TimelineCanvas';
import type { TimelinePin } from '../hooks/useTimelinePins';

// d3-zoom/d3-drag install global listeners on `window` that can leak across
// tests (mousemove.zoom, mouseup.zoom, click.drag). Mirror GraphCanvas.test.tsx
// cleanup discipline so a stuck listener doesn't cascade-fail later tests.
afterEach(() => {
  select(window).on('click.drag', null);
  select(window).on('mousemove.drag', null);
  select(window).on('mouseup.drag', null);
  select(window).on('dragstart.drag', null);
  select(window).on('selectstart.drag', null);
  select(window).on('mousemove.zoom', null);
  select(window).on('mouseup.zoom', null);
});

function pin(overrides: Partial<TimelinePin> & { id: string; position: number }): TimelinePin {
  return {
    id: overrides.id,
    entryId: overrides.entryId ?? `e-${overrides.id}`,
    label: overrides.label ?? `Pin ${overrides.id}`,
    position: overrides.position,
    precision: overrides.precision ?? 'exact',
    entryTitle: overrides.entryTitle,
    entryIcon: overrides.entryIcon,
    entryType: overrides.entryType,
  };
}

/**
 * Content-Forward Views §6: a pin is a medallion <g> translated into place, not a <circle>
 * with cx/cy. Read its centre back out of the transform so the position assertions below keep
 * asserting exactly what they always did.
 */
function pinCentre(el: Element): { x: number; y: number } {
  const m = /translate\(\s*([-\d.]+)\s*,\s*([-\d.]+)\s*\)/.exec(el.getAttribute('transform') ?? '');
  if (!m) throw new Error(`pin has no translate transform: ${el.getAttribute('transform')}`);
  return { x: Number(m[1]), y: Number(m[2]) };
}

const DEFAULT_PROPS = {
  universeId: 'U1',
  width: 800,
  height: 400,
  window: { start: 0, end: 1000 },
  calendar: null,
} as const;

/**
 * A pin whose id is `${entryId}-pin` and whose joined entry title is 'Aldric' — so the
 * medallion tests can assert a monogram ('A') without restating the fixture each time.
 */
function pinFor(entryId: string, position: number): TimelinePin {
  return pin({
    id: `${entryId}-pin`,
    entryId,
    position,
    entryTitle: 'Aldric',
    entryType: 'entity',
  });
}

function renderCanvas(props: Partial<TimelineCanvasProps> & { pins: TimelinePin[] }) {
  return render(<TimelineCanvas {...DEFAULT_PROPS} {...props} />);
}

describe('TimelineCanvas', () => {
  it('renders an SVG with data-testid="timeline-canvas" and ARIA role/label', () => {
    const { container } = render(
      <TimelineCanvas {...DEFAULT_PROPS} pins={[]} />,
    );
    const svg = container.querySelector('[data-testid="timeline-canvas"]');
    expect(svg).toBeTruthy();
    expect(svg?.getAttribute('role')).toBe('application');
    expect(svg?.getAttribute('aria-label')).toBe('Timeline canvas');
  });

  it('renders both era-layer and pin-layer <g> children in document order', () => {
    const { container } = render(
      <TimelineCanvas {...DEFAULT_PROPS} pins={[]} />,
    );
    const svg = container.querySelector('[data-testid="timeline-canvas"]') as SVGSVGElement;
    const groups = Array.from(svg.querySelectorAll(':scope > g'));
    // era-layer FIRST (behind), pin-layer SECOND (in front).
    expect(groups[0]?.getAttribute('class')).toMatch(/era-layer/);
    expect(groups[1]?.getAttribute('class')).toMatch(/pin-layer/);
    expect(container.querySelector('[data-testid="era-layer"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="pin-layer"]')).toBeTruthy();
  });

  it('renders one <rect> per era span in the era-layer (D-04 inference)', () => {
    const pins: TimelinePin[] = [
      pin({ id: 'a', position: 100, precision: 'era', label: 'First Age' }),
      pin({ id: 'b', position: 200, precision: 'exact' }),
      pin({ id: 'c', position: 500, precision: 'era', label: 'Second Age' }),
    ];
    const { container } = render(
      <TimelineCanvas {...DEFAULT_PROPS} pins={pins} />,
    );
    const eraRects = container.querySelectorAll('[data-testid="era-layer"] rect');
    expect(eraRects).toHaveLength(2);
  });

  it('renders one [data-pin-id] element per pin in the pin-layer', () => {
    const pins: TimelinePin[] = [
      pin({ id: 'a', position: 100 }),
      pin({ id: 'b', position: 300 }),
      pin({ id: 'c', position: 700 }),
    ];
    const { container } = render(
      <TimelineCanvas {...DEFAULT_PROPS} pins={pins} />,
    );
    const pinEls = container.querySelectorAll('[data-testid="pin-layer"] [data-pin-id]');
    expect(pinEls).toHaveLength(3);
    const ids = Array.from(pinEls).map((el) => el.getAttribute('data-pin-id'));
    expect(ids).toContain('a');
    expect(ids).toContain('b');
    expect(ids).toContain('c');
  });

  it('stacks pins at the same position vertically (different cy, same data-position)', () => {
    const pins: TimelinePin[] = [
      pin({ id: 'a', position: 400 }),
      pin({ id: 'b', position: 400 }),
    ];
    const { container } = render(
      <TimelineCanvas {...DEFAULT_PROPS} pins={pins} />,
    );
    const pinEls = Array.from(
      container.querySelectorAll('[data-testid="pin-layer"] [data-pin-id]'),
    ) as SVGElement[];
    expect(pinEls).toHaveLength(2);
    const positions = pinEls.map((el) => el.getAttribute('data-position'));
    expect(positions).toEqual(['400', '400']);
    const cys = pinEls.map((el) => pinCentre(el).y);
    // Both should be set, and they must differ (one at baseline, one stacked above).
    expect(cys[0]).not.toBeNull();
    expect(cys[1]).not.toBeNull();
    expect(cys[0]).not.toBe(cys[1]);
  });

  it('renders out-of-range pins clamped to the edge with data-clamped="true"', () => {
    const pins: TimelinePin[] = [
      pin({ id: 'low', position: -500 }), // before window.start
      pin({ id: 'mid', position: 500 }),
      pin({ id: 'high', position: 1500 }), // after window.end
    ];
    const { container } = render(
      <TimelineCanvas {...DEFAULT_PROPS} pins={pins} />,
    );
    const clampedEls = container.querySelectorAll(
      '[data-testid="pin-layer"] [data-pin-id][data-clamped="true"]',
    );
    expect(clampedEls).toHaveLength(2);
    const ids = Array.from(clampedEls).map((el) => el.getAttribute('data-pin-id'));
    expect(ids).toContain('low');
    expect(ids).toContain('high');

    // Chevron indicators rendered inside the out-of-range group.
    const oorGroup = container.querySelector('[data-testid="out-of-range"]');
    expect(oorGroup).toBeTruthy();
    expect(oorGroup!.children.length).toBeGreaterThan(0);
  });

  it('carries aria-label="{label} at position {position}" on in-range pins', () => {
    const pins: TimelinePin[] = [
      pin({ id: 'a', position: 250, label: 'Aelara is born' }),
    ];
    const { container } = render(
      <TimelineCanvas {...DEFAULT_PROPS} pins={pins} />,
    );
    const el = container.querySelector('[data-pin-id="a"]') as SVGElement;
    expect(el).toBeTruthy();
    expect(el.getAttribute('aria-label')).toBe('Aelara is born at position 250');
  });

  it('positions in-range pins via posToX (start at x=0, end at x=width)', () => {
    const pins: TimelinePin[] = [
      pin({ id: 'start', position: 0 }), // x should be 0
      pin({ id: 'mid', position: 500 }), // x should be 400 (half of width 800)
      pin({ id: 'end', position: 1000 }), // x should be 800
    ];
    const { container } = render(
      <TimelineCanvas {...DEFAULT_PROPS} pins={pins} />,
    );
    const start = container.querySelector('[data-pin-id="start"]') as SVGElement;
    const mid = container.querySelector('[data-pin-id="mid"]') as SVGElement;
    const end = container.querySelector('[data-pin-id="end"]') as SVGElement;
    expect(pinCentre(start).x).toBeCloseTo(0, 5);
    expect(pinCentre(mid).x).toBeCloseTo(400, 5);
    expect(pinCentre(end).x).toBeCloseTo(800, 5);
  });

  it('renders a baseline element inside the pin-layer', () => {
    const { container } = render(
      <TimelineCanvas {...DEFAULT_PROPS} pins={[]} />,
    );
    const baseline = container.querySelector('[data-testid="pin-layer"] [data-testid="baseline"]');
    expect(baseline).toBeTruthy();
  });

  describe('Content-Forward Views §6 — pin medallions', () => {
    it('renders each pin as a medallion group, not a bare dot', () => {
      const { container } = renderCanvas({ pins: [pinFor('e1', 100)] });
      const pinEl = container.querySelector('g[data-pin-id="e1-pin"]')!;
      expect(pinEl).toBeTruthy();
      expect(pinEl.querySelector('circle.medallion-disc')).toBeTruthy();
    });

    it("clips the pinned entry's cover into the pin when it has one", () => {
      const medallions = new Map([
        ['e1', { title: 'Aldric', entryType: 'entity', icon: '', coverThumbUrl: '/thumb-1.png' }],
      ]);
      const { container } = renderCanvas({ pins: [pinFor('e1', 100)], medallions });
      expect(container.querySelector('g[data-pin-id="e1-pin"] image')?.getAttribute('href'))
        .toBe('/thumb-1.png');
    });

    it('falls back to the monogram when the pinned entry has no cover', () => {
      const medallions = new Map([
        ['e1', { title: 'Aldric', entryType: 'entity', icon: '', coverThumbUrl: null }],
      ]);
      const { container } = renderCanvas({ pins: [pinFor('e1', 100)], medallions });
      const pinEl = container.querySelector('g[data-pin-id="e1-pin"]')!;
      expect(pinEl.querySelector('text.medallion-glyph')?.textContent).toBe('A');
      expect(pinEl.querySelector('image')).toBeNull();
    });

    it('namespaces the clipPath per surface so it cannot collide with the graph', () => {
      // SVG url(#…) resolves to the FIRST matching id in the document.
      const medallions = new Map([
        ['e1', { title: 'Aldric', entryType: 'entity', icon: '', coverThumbUrl: '/thumb-1.png' }],
      ]);
      const { container } = renderCanvas({ pins: [pinFor('e1', 100)], medallions });
      expect(container.querySelector('clipPath#medallion-clip-timeline-e1-pin')).toBeTruthy();
    });

    it('STILL opens the entry on a React click — the d3-datum pitfall must not return', () => {
      // Recorded bug: a d3 .on('click') handler on these React-rendered pins receives
      // d === undefined, throws, and its stopPropagation swallows the real click. The React
      // onClick is the ONLY open path. If this test fails, that bug is back.
      const onPinClick = vi.fn();
      const { container } = renderCanvas({ pins: [pinFor('e1', 100)], onPinClick });
      const pinEl = container.querySelector('g[data-pin-id="e1-pin"]') as SVGGElement;
      pinEl.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      expect(onPinClick).toHaveBeenCalledTimes(1);
    });

    it('shows a label beside an isolated pin, and hides it when pins crowd together', () => {
      const spaced = renderCanvas({ pins: [pinFor('e1', 100)] });
      expect(spaced.container.querySelector('text.timeline-pin-label')).toBeTruthy();

      // Two pins at nearly the same position have no room for both labels.
      const crowded = renderCanvas({ pins: [pinFor('e1', 100), pinFor('e2', 101)] });
      const labels = crowded.container.querySelectorAll('text.timeline-pin-label');
      expect(labels.length).toBeLessThan(2);
    });
  });
});
