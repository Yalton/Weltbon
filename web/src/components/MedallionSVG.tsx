import {
  MEDALLION_ICON_RATIO,
  MEDALLION_MONOGRAM_RATIO,
  resolveMedallion,
  type MedallionSource,
} from '../lib/medallion';

const SVG_NS = 'http://www.w3.org/2000/svg';

export interface MedallionSVGProps extends MedallionSource {
  /** Stable identity for this node — becomes the clipPath id (`medallion-clip-${id}`). */
  id: string;
  /** Disc radius in px. The medallion is drawn centred on (0,0); the caller positions it
   * with a `transform` on the parent element. */
  radius: number;
}

/**
 * The plain attribute values BOTH svg renderers need, derived once from resolveMedallion().
 * Neither MedallionSVGNode (JSX) nor appendMedallionNode (imperative DOM) computes fill,
 * opacity, or font-size itself — both read them from here, so the two cannot pick
 * different numbers for the same input. This is the "one helper, two shells" split: the
 * decisions live here, the DOM-construction style (JSX vs. createElementNS) is the only
 * thing that differs between the two renderers.
 */
interface MedallionSVGDescriptor {
  clipId: string;
  radius: number;
  hue: string;
  discFill: string;
  discFillOpacity: number;
  coverUrl: string | null;
  glyph: string | null;
  glyphFontSize: number;
  glyphFontFamily: string | null;
}

function describeMedallionSVG(props: MedallionSVGProps): MedallionSVGDescriptor {
  const m = resolveMedallion(props);
  const diameter = props.radius * 2;
  const clipId = `medallion-clip-${props.id}`;

  if (m.kind === 'cover') {
    return {
      clipId,
      radius: props.radius,
      hue: m.hue,
      discFill: m.svg.discFill,
      // Transparent fill: the disc's ring still strokes over the image, but its fill
      // must not paint over the cover it's clipping.
      discFillOpacity: 0,
      coverUrl: m.coverUrl,
      glyph: null,
      glyphFontSize: 0,
      glyphFontFamily: null,
    };
  }

  // Ratios are relative to the diameter (Medallion.tsx applies them to `px`, the HTML
  // disc's diameter) — radius * 2 gets the SVG renderer the same proportion.
  const glyph = m.kind === 'icon' ? m.icon : m.monogram;
  const ratio = m.kind === 'icon' ? MEDALLION_ICON_RATIO : MEDALLION_MONOGRAM_RATIO;

  return {
    clipId,
    radius: props.radius,
    hue: m.hue,
    discFill: m.svg.discFill,
    discFillOpacity: m.svg.discFillOpacity,
    coverUrl: null,
    glyph,
    glyphFontSize: diameter * ratio,
    // Only the monogram follows the universe's display font — an emoji has no font-family
    // opinion of its own.
    glyphFontFamily: m.kind === 'monogram' ? 'var(--font-display)' : null,
  };
}

/**
 * React SVG identity node for surfaces that MUST stay React-rendered — timeline pins.
 * (Recorded bug: a d3 `.on('click', (e, d) => …)` handler attached to a React-owned SVG
 * element sees `d === undefined` and throws, silently swallowing the click. See
 * appendMedallionNode below for the d3-owned twin.)
 *
 * Draws centred on (0,0); the caller positions the medallion with a `transform` on the
 * parent element (e.g. the pin's `<g transform="translate(x, y)">`).
 */
export function MedallionSVGNode(props: MedallionSVGProps) {
  const d = describeMedallionSVG(props);

  if (d.coverUrl) {
    return (
      <>
        <defs>
          <clipPath id={d.clipId}>
            <circle r={d.radius} />
          </clipPath>
        </defs>
        <image
          href={d.coverUrl}
          x={-d.radius}
          y={-d.radius}
          width={d.radius * 2}
          height={d.radius * 2}
          preserveAspectRatio="xMidYMid slice"
          clipPath={`url(#${d.clipId})`}
        />
        <circle
          className="medallion-disc"
          r={d.radius}
          fill={d.discFill}
          fillOpacity={d.discFillOpacity}
          stroke={d.hue}
          strokeWidth={2}
        />
      </>
    );
  }

  return (
    <>
      <circle
        className="medallion-disc"
        r={d.radius}
        fill={d.discFill}
        fillOpacity={d.discFillOpacity}
        stroke={d.hue}
        strokeWidth={2}
      />
      <text
        className="medallion-glyph"
        textAnchor="middle"
        dominantBaseline="central"
        fontSize={d.glyphFontSize}
        fontFamily={d.glyphFontFamily ?? undefined}
        style={{ userSelect: 'none' }}
      >
        {d.glyph}
      </text>
    </>
  );
}

function buildDisc(d: MedallionSVGDescriptor): SVGCircleElement {
  const circle = document.createElementNS(SVG_NS, 'circle');
  circle.setAttribute('class', 'medallion-disc');
  circle.setAttribute('r', String(d.radius));
  circle.setAttribute('fill', d.discFill);
  circle.setAttribute('fill-opacity', String(d.discFillOpacity));
  circle.setAttribute('stroke', d.hue);
  circle.setAttribute('stroke-width', '2');
  return circle;
}

function buildGlyph(d: MedallionSVGDescriptor): SVGTextElement {
  const text = document.createElementNS(SVG_NS, 'text');
  text.setAttribute('class', 'medallion-glyph');
  text.setAttribute('text-anchor', 'middle');
  text.setAttribute('dominant-baseline', 'central');
  text.setAttribute('font-size', String(d.glyphFontSize));
  if (d.glyphFontFamily) text.setAttribute('font-family', d.glyphFontFamily);
  text.textContent = d.glyph ?? '';
  return text;
}

/**
 * Imperative twin of MedallionSVGNode for surfaces owned by a d3 join — the graph —
 * which manages its own DOM and cannot mount React children into it. Builds the same
 * element shape from the same describeMedallionSVG() output, so the two renderers cannot
 * drift on fill, opacity, or glyph size.
 *
 * Idempotent: a d3 update selection re-runs this on every data change (a node's cover can
 * appear or disappear between renders), so every call first purges whatever a previous
 * call appended — wrapped in one `.medallion-node` group — before rebuilding.
 */
export function appendMedallionNode(group: SVGGElement, props: MedallionSVGProps): void {
  for (const child of Array.from(group.children)) {
    if (child instanceof SVGElement && child.classList.contains('medallion-node')) {
      group.removeChild(child);
    }
  }

  const d = describeMedallionSVG(props);
  const node = document.createElementNS(SVG_NS, 'g');
  node.setAttribute('class', 'medallion-node');

  if (d.coverUrl) {
    const defs = document.createElementNS(SVG_NS, 'defs');
    const clipPath = document.createElementNS(SVG_NS, 'clipPath');
    clipPath.setAttribute('id', d.clipId);
    const clipCircle = document.createElementNS(SVG_NS, 'circle');
    clipCircle.setAttribute('r', String(d.radius));
    clipPath.appendChild(clipCircle);
    defs.appendChild(clipPath);
    node.appendChild(defs);

    const image = document.createElementNS(SVG_NS, 'image');
    image.setAttribute('href', d.coverUrl);
    image.setAttribute('x', String(-d.radius));
    image.setAttribute('y', String(-d.radius));
    image.setAttribute('width', String(d.radius * 2));
    image.setAttribute('height', String(d.radius * 2));
    image.setAttribute('preserveAspectRatio', 'xMidYMid slice');
    image.setAttribute('clip-path', `url(#${d.clipId})`);
    node.appendChild(image);

    node.appendChild(buildDisc(d));
  } else {
    node.appendChild(buildDisc(d));
    node.appendChild(buildGlyph(d));
  }

  group.appendChild(node);
}
