import { createElement, type CSSProperties, type ReactElement } from 'react';
import {
  MEDALLION_ICON_RATIO,
  MEDALLION_MONOGRAM_RATIO,
  resolveMedallion,
  type MedallionSource,
} from '../lib/medallion';

const SVG_NS = 'http://www.w3.org/2000/svg';

const CLASS_ROOT = 'medallion-node';
const CLASS_DISC = 'medallion-disc';
const CLASS_GLYPH = 'medallion-glyph';

const RING_STROKE_WIDTH = 2;

const DECORATIVE_OVERLAY = {
  'pointer-events': 'none',
  'aria-hidden': 'true',
} as const;

const GLYPH_ANCHORING = {
  'text-anchor': 'middle',
  'dominant-baseline': 'central',
} as const;

const GLYPH_STYLE: CSSProperties = { userSelect: 'none' };

const COVER_FIT = 'xMidYMid slice';

export interface MedallionSVGProps extends MedallionSource {
  id: string;
  radius: number;
}

interface ElementSpec {
  tag: string;
  className?: string;
  attrs?: Record<string, string | number>;
  style?: CSSProperties;
  text?: string;
  children?: ElementSpec[];
}

function describeMedallionSVG(props: MedallionSVGProps): ElementSpec {
  const m = resolveMedallion(props);
  const { radius } = props;
  const diameter = radius * 2;
  const clipId = `medallion-clip-${props.id}`;

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
          // font-family opinion of its own.
          ...(isIcon ? {} : { 'font-family': 'var(--font-display)' }),
        },
        style: GLYPH_STYLE,
        text: isIcon ? m.icon : m.monogram,
      },
    ],
  };
}

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
  // what React produces from the same object — the tree-equality test depends on it.
  for (const [name, value] of Object.entries(spec.style ?? {})) {
    el.style.setProperty(name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`), String(value));
  }
  if (spec.text !== undefined) el.textContent = spec.text;
  for (const child of spec.children ?? []) el.appendChild(toDOM(child));
  return el;
}

export function MedallionSVGNode(props: MedallionSVGProps): ReactElement {
  return toReact(describeMedallionSVG(props));
}

export function appendMedallionNode(group: SVGGElement, props: MedallionSVGProps): void {
  // Direct children only — a `.medallion-node` deeper in the group is not ours to remove.
  // NOT `querySelectorAll(':scope > .medallion-node')`: jsdom's selector engine matches
  for (const child of Array.from(group.children)) {
    if (child.classList.contains(CLASS_ROOT)) child.remove();
  }
  group.appendChild(toDOM(describeMedallionSVG(props)));
}
