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

  it('lets pointer events fall through the glyph and the cover to the disc beneath', () => {
    // The graph binds click/drag/hover to the node CIRCLE, not to a wrapping <g>. An overlay
    // that accepts pointer events would silently swallow clicks aimed at the node — clicking
    // an entry's portrait or its monogram letter would do nothing.
    const cover = renderNode({
      id: 'p1',
      title: 'Aldric',
      entryType: 'entity',
      coverThumbUrl: '/thumb.png',
      radius: 9,
    });
    expect(cover.querySelector('image')?.getAttribute('pointer-events')).toBe('none');

    const mono = renderNode({ id: 'p2', title: 'Aldric', entryType: 'entity', radius: 9 });
    expect(mono.querySelector('text')?.getAttribute('pointer-events')).toBe('none');
    // The disc is the hit target — it must NOT opt out.
    expect(mono.querySelector('circle.medallion-disc')?.getAttribute('pointer-events')).toBeNull();
  });

  it('marks the glyph and the cover decorative, like the HTML renderer', () => {
    // SVG <text> is exposed to the a11y tree by default, unlike an HTML <img alt="">. The
    // medallion always sits beside the already-announced title, so announcing it is noise.
    const cover = renderNode({
      id: 'a1',
      title: 'Aldric',
      entryType: 'entity',
      coverThumbUrl: '/thumb.png',
      radius: 9,
    });
    expect(cover.querySelector('image')?.getAttribute('aria-hidden')).toBe('true');

    const mono = renderNode({ id: 'a2', title: 'Aldric', entryType: 'entity', radius: 9 });
    expect(mono.querySelector('text')?.getAttribute('aria-hidden')).toBe('true');
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

/**
 * The whole reason MedallionSVG exists as one module is that its two shells cannot drift.
 * Comparing a couple of hand-picked attributes did NOT enforce that — a `stroke-width` or
 * `preserveAspectRatio` set in one shell and forgotten in the other would sail through.
 * Comparing the full attribute tree does: ANY attribute either shell adds unilaterally fails
 * this automatically. (Mutation-checked: setting RING_STROKE_WIDTH in only one shell turns
 * all three cases red.)
 */
function serialize(el: Element): unknown {
  return {
    tag: el.tagName.toLowerCase(),
    attrs: Object.fromEntries(
      Array.from(el.attributes)
        .map((a) => [a.name, a.value] as const)
        .sort(([a], [b]) => a.localeCompare(b)),
    ),
    text: el.children.length === 0 ? el.textContent : undefined,
    children: Array.from(el.children).map(serialize),
  };
}

const AGREEMENT_CASES = {
  cover: { title: 'Aldric', entryType: 'entity', coverThumbUrl: '/thumb.png' },
  icon: { title: 'Aldric', entryType: 'entity', icon: '👑' },
  monogram: { title: 'Vale', entryType: 'location' },
} as const;

describe('the two renderers agree', () => {
  it.each(Object.keys(AGREEMENT_CASES) as (keyof typeof AGREEMENT_CASES)[])(
    'React and imperative renderers produce an identical attribute tree (%s)',
    (kind) => {
      // Both shells get the SAME id, so the clipPath id and the clip-path url() reference
      // are directly comparable too — nothing has to be filtered out of the comparison.
      const props = { id: 'same', radius: 12, ...AGREEMENT_CASES[kind] };

      const reactRoot = renderNode(props).querySelector('g.medallion-node')!;
      const g = emptyGroup();
      appendMedallionNode(g, props);

      expect(serialize(g.firstElementChild!)).toEqual(serialize(reactRoot));
    },
  );
});
