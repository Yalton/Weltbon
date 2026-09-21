import { entryTypeHexColor } from './entryTypeColor';


export type MedallionKind = 'cover' | 'icon' | 'monogram';

export type MedallionSize = 'sm' | 'md' | 'lg';

export const MEDALLION_SIZES: Record<MedallionSize, number> = {
  sm: 36,
  md: 44,
  lg: 52,
};

export const MEDALLION_ICON_RATIO = 0.5;
export const MEDALLION_MONOGRAM_RATIO = 0.45;

export interface MedallionSource {
  title: string;
  entryType: string;
  icon?: string | null;
  coverThumbUrl?: string | null;
}

interface MedallionPresentation {
  monogram: string;
  hue: string;
  html: {
    discBackground: string;
    ringColor: string;
  };
  svg: {
    discFill: string;
    discFillOpacity: number;
  };
}

export type ResolvedMedallion = MedallionPresentation &
  (
    | { kind: 'cover'; coverUrl: string; icon: string | null }
    | { kind: 'icon'; coverUrl: null; icon: string }
    | { kind: 'monogram'; coverUrl: null; icon: null }
  );

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
  const coverUrl = src.coverThumbUrl ? src.coverThumbUrl : null;
  const icon = src.icon ? src.icon : null;

  const presentation: MedallionPresentation = {
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

  if (coverUrl) return { ...presentation, kind: 'cover', coverUrl, icon };
  if (icon) return { ...presentation, kind: 'icon', coverUrl: null, icon };
  return { ...presentation, kind: 'monogram', coverUrl: null, icon: null };
}
