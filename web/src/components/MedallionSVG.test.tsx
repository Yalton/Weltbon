import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { MedallionSVGNode, appendMedallionNode } from './MedallionSVG';

function renderNode(props: Parameters<typeof MedallionSVGNode>[0]) {
  const { container } = render(
    <svg>
      <MedallionSVGNode {...props} />
    </svg>,
  );
  return container;
}

function emptyGroup(): SVGGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
  svg.appendChild(g);
  document.body.appendChild(svg);
  return g;
}

describe('MedallionSVGNode (React)', () => {
  it('renders a clipped <image> when a cover is present', () => {
    const c = renderNode({
      id: 'e1',
      title: 'Aldric',
      entryType: 'entity',
      icon: '👑',
      coverThumbUrl: '/thumb.png',
      radius: 9,
    });
    const img = c.querySelector('image')!;
    expect(img).toBeTruthy();
    expect(img.getAttribute('href')).toBe('/thumb.png');
    expect(img.getAttribute('clip-path')).toBe('url(#medallion-clip-e1)');
    expect(c.querySelector('clipPath#medallion-clip-e1 circle')?.getAttribute('r')).toBe('9');
    expect(c.querySelector('text')).toBeNull();
  });

  it('renders the emoji as <text> when there is no cover', () => {
    const c = renderNode({ id: 'e2', title: 'Aldric', entryType: 'entity', icon: '👑', radius: 9 });
    expect(c.querySelector('image')).toBeNull();
    expect(c.querySelector('text')?.textContent).toBe('👑');
  });

  it('renders the monogram as <text> when there is neither cover nor icon', () => {
    const c = renderNode({ id: 'e3', title: 'Aldric', entryType: 'entity', radius: 9 });
    const text = c.querySelector('text')!;
    expect(text.textContent).toBe('A');
    expect(text.getAttribute('font-family')).toBe('var(--font-display)');
  });

  it('rings the disc in the entry-type hue', () => {
    const c = renderNode({ id: 'e4', title: 'Vale', entryType: 'location', radius: 9 });
    const disc = c.querySelector('circle.medallion-disc')!;
    expect(disc.getAttribute('stroke')).toBe('#f59e0b');
    expect(disc.getAttribute('r')).toBe('9');
  });
});

describe('appendMedallionNode (imperative twin for the d3 join)', () => {
  it('produces the same element shape as the React renderer for a cover', () => {
    const g = emptyGroup();
    appendMedallionNode(g, {
      id: 'n1',
      title: 'Aldric',
      entryType: 'entity',
      coverThumbUrl: '/thumb.png',
      radius: 14,
    });
    expect(g.querySelector('image')?.getAttribute('href')).toBe('/thumb.png');
    expect(g.querySelector('clipPath#medallion-clip-n1')).toBeTruthy();
    expect(g.querySelector('circle.medallion-disc')?.getAttribute('stroke')).toBe('#10b981');
  });

  it('produces a monogram <text> when the entry has no cover and no icon', () => {
    const g = emptyGroup();
    appendMedallionNode(g, { id: 'n2', title: 'gondor', entryType: 'location', radius: 14 });
    expect(g.querySelector('text.medallion-glyph')?.textContent).toBe('G');
    expect(g.querySelector('image')).toBeNull();
  });

  it('is idempotent — re-appending replaces rather than stacking duplicate glyphs', () => {
    const g = emptyGroup();
    appendMedallionNode(g, { id: 'n3', title: 'A', entryType: 'entity', radius: 14 });
    appendMedallionNode(g, { id: 'n3', title: 'A', entryType: 'entity', radius: 20 });
    // The d3 update selection re-runs this on every data change; without a purge the node
    // would accumulate one disc per re-render.
    expect(g.querySelectorAll('circle.medallion-disc')).toHaveLength(1);
    expect(g.querySelector('circle.medallion-disc')?.getAttribute('r')).toBe('20');
  });

  it('does not leave a stale cover <image> behind when an entry loses its cover', () => {
    // A d3 update selection re-runs appendMedallionNode on the SAME group when the data
    // changes. If the purge is incomplete, an entry whose cover was removed would keep
    // showing the old portrait forever.
    const g = emptyGroup();
    appendMedallionNode(g, { id: 'n4', title: 'Was', entryType: 'entity', coverThumbUrl: '/x.png', radius: 14 });
    expect(g.querySelector('image')).toBeTruthy();

    appendMedallionNode(g, { id: 'n4', title: 'Was', entryType: 'entity', radius: 14 });
    expect(g.querySelector('image')).toBeNull();
    expect(g.querySelector('text.medallion-glyph')?.textContent).toBe('W');
    expect(g.querySelectorAll('clipPath')).toHaveLength(0);
  });
});

describe('the two renderers agree', () => {
  it('produce the same kind of glyph for the same input', () => {
    // The contract exists so HTML/SVG cannot drift. These two paths are the SVG half of
    // that promise: React and imperative must resolve identically.
    const props = { id: 'same', title: 'Vale', entryType: 'location', radius: 12 } as const;

    const reactC = renderNode({ ...props });
    const g = emptyGroup();
    appendMedallionNode(g, { ...props });

    expect(g.querySelector('text.medallion-glyph')?.textContent).toBe(
      reactC.querySelector('text')?.textContent,
    );
    expect(g.querySelector('circle.medallion-disc')?.getAttribute('stroke')).toBe(
      reactC.querySelector('circle.medallion-disc')?.getAttribute('stroke'),
    );
  });
});
