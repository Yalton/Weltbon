import { afterEach, describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import { select } from 'd3-selection';
import { TimelineCanvas } from './TimelineCanvas';
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

const DEFAULT_PROPS = {
  universeId: 'U1',
  width: 800,
  height: 400,
  window: { start: 0, end: 1000 },
} as const;

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
    const cys = pinEls.map((el) => el.getAttribute('cy'));
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

  it('positions in-range pin cx via posToX (start at x=0, end at x=width)', () => {
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
    expect(Number(start.getAttribute('cx'))).toBeCloseTo(0, 5);
    expect(Number(mid.getAttribute('cx'))).toBeCloseTo(400, 5);
    expect(Number(end.getAttribute('cx'))).toBeCloseTo(800, 5);
  });

  it('renders a baseline element inside the pin-layer', () => {
    const { container } = render(
      <TimelineCanvas {...DEFAULT_PROPS} pins={[]} />,
    );
    const baseline = container.querySelector('[data-testid="pin-layer"] [data-testid="baseline"]');
    expect(baseline).toBeTruthy();
  });
});
