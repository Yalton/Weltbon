import { entryTypeHexColor } from './entryTypeColor';

/**
 * Content-Forward Views §2 — the single identity contract.
 *
 * Every surface that draws an entry's identity (list rows, graph nodes, timeline
 * pins, map tooltips, detail/editor hero fallback) resolves it HERE. The HTML
 * renderer (Medallion.tsx) and the SVG renderer (MedallionSVG.tsx) are both thin
 * shells over this function, which is what stops the two from drifting apart.
 */

export type MedallionKind = 'cover' | 'icon' | 'monogram';

export type MedallionSize = 'sm' | 'md' | 'lg';

/** Diameters in px (spec §2). */
export const MEDALLION_SIZES: Record<MedallionSize, number> = {
  sm: 36,
  md: 44,
  lg: 52,
};

/** The minimum an entry must expose to be drawn as a medallion. */
export interface MedallionSource {
  title: string;
  entryType: string;
  /** Emoji from entries.icon. The API sends '' (not null) when unset. */
  icon?: string | null;
  /** Pre-signed thumb URL from the entries LIST projection. */
  coverThumbUrl?: string | null;
}

export interface ResolvedMedallion {
  kind: MedallionKind;
  coverUrl: string | null;
  icon: string | null;
  /** First grapheme of the title, uppercased. '?' when the title is empty. */
  monogram: string;
  /** Entry-type hex, e.g. '#f59e0b'. Shared: HTML tints with it, SVG strokes with it. */
  hue: string;
  /** Presentation values for the HTML renderer (Medallion.tsx). */
  html: {
    /** CSS background for the fallback disc. */
    discBackground: string;
    /** Hairline inset ring color, for box-shadow. Not used by SVG, which strokes with `hue`. */
    ringColor: string;
  };
  /** Presentation values for the SVG renderer (MedallionSVG.tsx), which cannot take a CSS gradient. */
  svg: {
    /** Flat disc fill — the gradient's stand-in on SVG surfaces. */
    discFill: string;
    /** Flat approximation of the gradient's visual weight (mockup B). */
    discFillOpacity: number;
  };
}

/**
 * First *grapheme* — not first code unit. `'🜂Ash'[0]` is a lone surrogate half, which
 * renders as mojibake.
 *
 * Intl.Segmenter is grapheme-cluster-correct. The spread fallback (older browsers —
 * Firefox only shipped Segmenter in v125) is only code-point-safe: it keeps surrogate
 * pairs intact but WOULD truncate a flag emoji, an emoji+ZWJ sequence, or a
 * base+combining-accent to its first code point. Degraded, not wrong enough to matter
 * for a monogram.
 */
export function firstGrapheme(title: string): string {
  const trimmed = title.trim();
  if (!trimmed) return '?';

  let first: string | undefined;
  if (typeof Intl !== 'undefined' && 'Segmenter' in Intl) {
    const seg = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
    first = seg.segment(trimmed)[Symbol.iterator]().next().value?.segment;
  } else {
    first = [...trimmed][0];
  }
  return (first ?? '?').toUpperCase();
}

export function resolveMedallion(src: MedallionSource): ResolvedMedallion {
  const hue = entryTypeHexColor(src.entryType);
  // The API sends '' for an unset icon and null for an unset cover — treat both
  // falsy shapes as absent so the resolution order is honest.
  const coverUrl = src.coverThumbUrl ? src.coverThumbUrl : null;
  const icon = src.icon ? src.icon : null;

  const kind: MedallionKind = coverUrl ? 'cover' : icon ? 'icon' : 'monogram';

  return {
    kind,
    coverUrl,
    icon,
    monogram: firstGrapheme(src.title),
    hue,
    html: {
      // The approved mockup B disc: an off-centre highlight fading into a dim base.
      // Requires 6-digit hex from entryTypeHexColor — pinned by entryTypeColor.test.ts.
      discBackground: `radial-gradient(circle at 35% 30%, ${hue}33, ${hue}12)`,
      ringColor: `${hue}55`,
    },
    svg: {
      discFill: hue,
      discFillOpacity: 0.18,
    },
  };
}
