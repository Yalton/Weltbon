import { createElement, type CSSProperties, type ReactElement } from 'react';
import {
  MEDALLION_ICON_RATIO,
  MEDALLION_MONOGRAM_RATIO,
  resolveMedallion,
  type MedallionSource,
} from '../lib/medallion';

const SVG_NS = 'http://www.w3.org/2000/svg';

/** Class names, hoisted so the two shells and their callers cannot spell them differently. */
const CLASS_ROOT = 'medallion-node';
const CLASS_DISC = 'medallion-disc';
const CLASS_GLYPH = 'medallion-glyph';

/** Ring weight. One literal, read by the disc spec only. */
const RING_STROKE_WIDTH = 2;

/**
 * The glyph and the cover sit ON TOP of the disc. In the graph, the node's click / drag /
 * hover handlers are bound to the node circle itself (GraphCanvas binds them to the circle,
 * not to a wrapping <g>), so any overlay that accepts pointer events would silently eat
 * clicks aimed at the node — you would click an entry's portrait or its monogram letter and
 * nothing would happen. Every overlay in GraphCanvas already sets pointer-events="none" for
 * exactly this reason; the medallion follows the convention. The disc keeps default pointer
 * events: it may itself be the hit target.
 *
 * aria-hidden for the same reason the HTML renderer uses alt="" / aria-hidden: the medallion
 * always sits beside the entry's already-announced title, so its cover, emoji, and monogram
 * are decorative and redundant. Unlike an HTML <img>, SVG <text> IS exposed to the a11y tree
 * by default, so this has to be explicit or the glyph gets announced.
 */
const DECORATIVE_OVERLAY = {
  'pointer-events': 'none',
  'aria-hidden': 'true',
} as const;

/** Text-centring on (0,0), shared by the emoji and the monogram. */
const GLYPH_ANCHORING = {
  'text-anchor': 'middle',
  'dominant-baseline': 'central',
} as const;

/** Dragging a graph node must not start a text selection on its letter. */
const GLYPH_STYLE: CSSProperties = { userSelect: 'none' };

const COVER_FIT = 'xMidYMid slice';

export interface MedallionSVGProps extends MedallionSource {
  /**
   * Stable id, unique across every medallion MOUNTED AT ONCE — it namespaces the <clipPath>.
   * SVG url(#…) resolves to the first matching id in the document, so a duplicate would
   * silently clip against the wrong circle (wrong radius, no error). Callers on distinct
   * surfaces must prefix: `graph-${entry.id}`, `timeline-${pin.id}`. Safe today only because
   * the graph and timeline live on mutually-exclusive routes (App.tsx) — do not rely on that
   * if you ever co-mount them.
   */
  id: string;
  /**
   * Disc radius in px. The medallion is drawn centred on (0,0); the caller positions it with
   * a `transform` on the parent element.
   */
  radius: number;
}

/**
 * A renderer-agnostic description of one SVG element. Attribute names are the real SVG ones
 * (hyphenated); React passes those through verbatim on DOM elements, and the imperative
 * builder setAttribute()s them, so ONE spec produces identical DOM through both shells.
 */
interface ElementSpec {
  tag: string;
  className?: string;
  attrs?: Record<string, string | number>;
  style?: CSSProperties;
  text?: string;
  children?: ElementSpec[];
}

/**
 * The single source of truth for what an SVG medallion IS. Neither shell decides anything —
 * they only walk this tree. That is what makes the anti-drift promise structural rather than
 * aspirational: there is no attribute one shell could set and the other forget, because
 * neither shell names an attribute at all.
 */
function describeMedallionSVG(props: MedallionSVGProps): ElementSpec {
  const m = resolveMedallion(props);
  const { radius } = props;
  const diameter = radius * 2;
  const clipId = `medallion-clip-${props.id}`;

  // Fill must be transparent behind a cover — otherwise the tinted disc paints over the
  // portrait it is meant to be framing. The ring still strokes on top.
  const disc = (fillOpacity: number): ElementSpec => ({
    tag: 'circle',
    className: CLASS_DISC,
    attrs: {
      r: radius,
      fill: m.svg.discFill,
      'fill-opacity': fillOpacity,
      stroke: m.hue,
      'stroke-width': RING_STROKE_WIDTH,
    },
  });

  if (m.kind === 'cover') {
    return {
      tag: 'g',
      className: CLASS_ROOT,
      children: [
        {
          tag: 'defs',
          children: [
            {
              tag: 'clipPath',
              attrs: { id: clipId },
              children: [{ tag: 'circle', attrs: { r: radius } }],
            },
          ],
        },
        {
          tag: 'image',
          attrs: {
            href: m.coverUrl,
            x: -radius,
            y: -radius,
            width: diameter,
            height: diameter,
            preserveAspectRatio: COVER_FIT,
            'clip-path': `url(#${clipId})`,
            ...DECORATIVE_OVERLAY,
          },
        },
        disc(0),
      ],
    };
  }

  // The ratios are relative to the DIAMETER — Medallion.tsx applies them to `px`, the HTML
  // disc's diameter — so the SVG renderer multiplies the radius by 2 to land on the same
  // glyph-to-disc proportion.
  const isIcon = m.kind === 'icon';
  const ratio = isIcon ? MEDALLION_ICON_RATIO : MEDALLION_MONOGRAM_RATIO;

  return {
    tag: 'g',
    className: CLASS_ROOT,
    children: [
      disc(m.svg.discFillOpacity),
      {
        tag: 'text',
        className: CLASS_GLYPH,
        attrs: {
          ...GLYPH_ANCHORING,
          ...DECORATIVE_OVERLAY,
          'font-size': diameter * ratio,
          // Only the monogram takes the universe's display font; an emoji has no
          // font-family opinion of its own.
          ...(isIcon ? {} : { 'font-family': 'var(--font-display)' }),
        },
        style: GLYPH_STYLE,
        text: isIcon ? m.icon : m.monogram,
      },
    ],
  };
}

/**
 * The spec names attributes the way SVG does (hyphenated) because the imperative shell
 * setAttribute()s them verbatim. React, on a DOM element, wants camelCase for every SVG
 * attribute it knows — hand it `fill-opacity` and it logs "Invalid DOM property
 * `fill-opacity`. Did you mean `fillOpacity`?" on EVERY render, then passes it through
 * anyway. That pass-through is what made both shells agree; it is React tolerating us, not
 * React agreeing with us, so translate at the boundary instead of relying on it.
 *
 * Only the React shell translates. The DOM shell keeps emitting the hyphenated names, and
 * React serializes the camelCase props back to those same hyphenated DOM attributes — which
 * is why the two-shell attribute-tree equality test still holds (it reads el.attributes, not
 * the props). An attribute absent from this map (e.g. `preserveAspectRatio`, `href`, `id`,
 * `x`/`y`/`r`) is already spelled the way React wants it and passes through untouched.
 */
const REACT_ATTR_NAME: Record<string, string> = {
  'fill-opacity': 'fillOpacity',
  'stroke-width': 'strokeWidth',
  'text-anchor': 'textAnchor',
  'dominant-baseline': 'dominantBaseline',
  'pointer-events': 'pointerEvents',
  'font-size': 'fontSize',
  'font-family': 'fontFamily',
  'font-weight': 'fontWeight',
  'clip-path': 'clipPath',
};

function toReactAttrs(attrs: ElementSpec['attrs']): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  for (const [name, value] of Object.entries(attrs ?? {})) {
    out[REACT_ATTR_NAME[name] ?? name] = value;
  }
  return out;
}

function toReact(spec: ElementSpec, key?: number): ReactElement {
  return createElement(
    spec.tag,
    { key, className: spec.className, style: spec.style, ...toReactAttrs(spec.attrs) },
    spec.text ?? spec.children?.map((child, i) => toReact(child, i)),
  );
}

function toDOM(spec: ElementSpec): SVGElement {
  const el = document.createElementNS(SVG_NS, spec.tag) as SVGElement;
  if (spec.className) el.setAttribute('class', spec.className);
  for (const [name, value] of Object.entries(spec.attrs ?? {})) {
    el.setAttribute(name, String(value));
  }
  // Written through CSSOM (not setAttribute) so the serialized `style` attribute matches
  // what React produces from the same object — the tree-equality test depends on it.
  for (const [name, value] of Object.entries(spec.style ?? {})) {
    el.style.setProperty(name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`), String(value));
  }
  if (spec.text !== undefined) el.textContent = spec.text;
  for (const child of spec.children ?? []) el.appendChild(toDOM(child));
  return el;
}

/**
 * React SVG identity node, for surfaces that MUST stay React-rendered — the timeline pins.
 * (Recorded bug: a d3 `.on('click', (e, d) => …)` handler bound to a React-owned SVG element
 * sees `d === undefined` and throws, silently swallowing the click.)
 *
 * Drawn centred on (0,0); the caller positions it with a `transform` on the parent.
 */
export function MedallionSVGNode(props: MedallionSVGProps): ReactElement {
  return toReact(describeMedallionSVG(props));
}

/**
 * Imperative twin of MedallionSVGNode, for surfaces owned by a d3 join — the graph — which
 * manages its own DOM and cannot mount React children into it. Walks the SAME spec tree, so
 * the two shells produce identical DOM by construction (MedallionSVG.test.tsx compares their
 * full attribute trees, so an attribute added to one shell and not the other cannot pass).
 *
 * Idempotent: a d3 update selection re-runs this on the same group on every data change (an
 * entry's cover can appear or disappear between renders), so each call first purges the
 * `.medallion-node` group a previous call appended, then rebuilds.
 */
export function appendMedallionNode(group: SVGGElement, props: MedallionSVGProps): void {
  // Direct children only — a `.medallion-node` deeper in the group is not ours to remove.
  // NOT `querySelectorAll(':scope > .medallion-node')`: jsdom's selector engine matches
  // `:scope >` against zero SVG elements (classList.contains and Element.matches both work
  // on them, only the `:scope` combinator does not), which silently defeated the purge and
  // turned both idempotence tests red.
  for (const child of Array.from(group.children)) {
    if (child.classList.contains(CLASS_ROOT)) child.remove();
  }
  group.appendChild(toDOM(describeMedallionSVG(props)));
}
