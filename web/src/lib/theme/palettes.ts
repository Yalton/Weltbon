import type { UniverseTheme } from '../../types/theme';

export type ThemeVars = Record<string, string>;

/** hex '#rrggbb' → [r,g,b] */
function rgb(hex: string): [number, number, number] {
  return [
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16),
  ];
}

/** mix hex toward white by t (0..1), returns '#rrggbb' */
function towardWhite(hex: string, t: number): string {
  const [r, g, b] = rgb(hex);
  const c = (v: number) => Math.round(v + (255 - v) * t).toString(16).padStart(2, '0');
  return `#${c(r)}${c(g)}${c(b)}`;
}

function glow(hex: string, px: number, alpha: number): string {
  const [r, g, b] = rgb(hex);
  return `0 0 ${px}px rgb(${r} ${g} ${b} / ${alpha})`;
}

/** mix hex toward black by t (0..1), returns '#rrggbb' */
function towardBlack(hex: string, t: number): string {
  const [r, g, b] = rgb(hex);
  const c = (v: number) => Math.round(v * (1 - t)).toString(16).padStart(2, '0');
  return `#${c(r)}${c(g)}${c(b)}`;
}

/** All accent-derived tokens from a base accent hex (spec §2.1). */
export function deriveAccent(hex: string): ThemeVars {
  const strong = towardWhite(hex, 0.3);
  const [sr, sg, sb] = rgb(strong);
  return {
    '--color-accent': hex,
    '--color-accent-strong': strong,
    '--color-accent-deep': towardBlack(hex, 0.18),
    '--color-accent-ink': towardWhite(hex, 0.7),
    '--color-accent-ring': `rgb(${sr} ${sg} ${sb} / 0.18)`,
    '--shadow-glow-accent': glow(hex, 20, 0.3),
    '--shadow-glow-soft': glow(strong, 18, 0.12),
  };
}

/** Canvas stops per palette + accent set (mockup-approved values, spec §2.1). */
export const PALETTES: Record<
  NonNullable<UniverseTheme['palette']>,
  ThemeVars
> = {
  observatory: {
    '--color-canvas-hi': '#151b31',
    '--color-canvas-mid': '#0b0e1c',
    '--color-canvas-lo': '#070912',
    ...deriveAccent('#6366f1'),
    // Preserve the exact Wave-1 defaults rather than derived approximations:
    '--color-accent-strong': '#818cf8',
    '--color-accent-deep': '#4f46e5',
    '--color-accent-ink': '#c7d2fe',
    '--color-accent-ring': 'rgb(165 180 252 / 0.18)',
  },
  ember: {
    '--color-canvas-hi': '#2b1712',
    '--color-canvas-mid': '#170c09',
    '--color-canvas-lo': '#0d0605',
    ...deriveAccent('#ea580c'),
  },
  verdant: {
    '--color-canvas-hi': '#122b1e',
    '--color-canvas-mid': '#091710',
    '--color-canvas-lo': '#050d08',
    ...deriveAccent('#059669'),
  },
  abyssal: {
    '--color-canvas-hi': '#1d1230',
    '--color-canvas-mid': '#0f0918',
    '--color-canvas-lo': '#08050d',
    ...deriveAccent('#9333ea'),
  },
  parchment: {
    '--color-canvas-hi': '#2b2114',
    '--color-canvas-mid': '#1a140c',
    '--color-canvas-lo': '#0f0b06',
    ...deriveAccent('#b07d2e'),
  },
};

export const FONT_STACKS: Record<NonNullable<UniverseTheme['displayFont']>, string> = {
  spectral: "'Spectral', Georgia, 'Times New Roman', serif",
  cormorant: "'Cormorant Garamond', Georgia, serif",
  cinzel: "'Cinzel', Georgia, serif",
  crimson: "'Crimson Pro', Georgia, serif",
};

/** Resolve a UniverseTheme into CSS custom properties for ThemeScope. */
export function themeToCssVars(theme: UniverseTheme | null | undefined): ThemeVars {
  if (!theme) return {};
  const vars: ThemeVars = {};
  if (theme.palette) Object.assign(vars, PALETTES[theme.palette]);
  if (theme.accent) Object.assign(vars, deriveAccent(theme.accent));
  if (theme.displayFont) vars['--font-display'] = FONT_STACKS[theme.displayFont];
  return vars;
}
