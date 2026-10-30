import type { UniverseTheme } from '../../types/theme';

export type ThemeVars = Record<string, string>;

function rgb(hex: string): [number, number, number] {
  return [
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16),
  ];
}

function towardWhite(hex: string, t: number): string {
  const [r, g, b] = rgb(hex);
  const c = (v: number) => Math.round(v + (255 - v) * t).toString(16).padStart(2, '0');
  return `#${c(r)}${c(g)}${c(b)}`;
}

function towardBlack(hex: string, t: number): string {
  const [r, g, b] = rgb(hex);
  const c = (v: number) => Math.round(v * (1 - t)).toString(16).padStart(2, '0');
  return `#${c(r)}${c(g)}${c(b)}`;
}

export function deriveAccent(hex: string): ThemeVars {
  const strong = towardWhite(hex, 0.3);
  const [r, g, b] = rgb(hex);
  const [sr, sg, sb] = rgb(strong);
  return {
    '--color-accent': hex,
    '--color-accent-strong': strong,
    '--color-accent-deep': towardBlack(hex, 0.18),
    '--color-accent-ink': towardWhite(hex, 0.7),
    '--color-accent-ring': `rgb(${sr} ${sg} ${sb} / 0.18)`,
    '--color-accent-soft': `rgb(${r} ${g} ${b} / 0.18)`,
  };
}

export const PALETTES: Record<
  NonNullable<UniverseTheme['palette']>,
  ThemeVars
> = {
  observatory: {
    '--color-canvas-hi': '#131a2c',
    '--color-canvas-mid': '#0b0f1c',
    '--color-canvas-lo': '#070a13',
    ...deriveAccent('#8ea2d4'),
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

export function themeToCssVars(theme: UniverseTheme | null | undefined): ThemeVars {
  if (!theme) return {};
  const vars: ThemeVars = {};
  if (theme.palette) Object.assign(vars, PALETTES[theme.palette]);
  if (theme.accent) Object.assign(vars, deriveAccent(theme.accent));
  if (theme.displayFont) vars['--font-display'] = FONT_STACKS[theme.displayFont];
  return vars;
}
