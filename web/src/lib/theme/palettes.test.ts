import { describe, it, expect } from 'vitest';
import { PALETTES, FONT_STACKS, themeToCssVars, deriveAccent } from './palettes';

const TOKEN_KEYS = [
  '--color-canvas-hi', '--color-canvas-mid', '--color-canvas-lo',
  '--color-accent', '--color-accent-strong', '--color-accent-deep',
  '--color-accent-ink', '--color-accent-ring',
  '--shadow-glow-accent', '--shadow-glow-soft',
] as const;

describe('PALETTES', () => {
  it('defines all five palettes with every themable token', () => {
    expect(Object.keys(PALETTES).sort()).toEqual(
      ['abyssal', 'ember', 'observatory', 'parchment', 'verdant'],
    );
    for (const p of Object.values(PALETTES)) {
      for (const k of TOKEN_KEYS) expect(p[k], `missing ${k}`).toBeTruthy();
    }
  });
});

describe('deriveAccent', () => {
  it('produces all accent tokens from a hex', () => {
    const d = deriveAccent('#ea580c');
    expect(d['--color-accent']).toBe('#ea580c');
    expect(d['--color-accent-strong']).toMatch(/^#[0-9a-f]{6}$/);
    expect(d['--color-accent-ring']).toContain('0.18');
    expect(d['--shadow-glow-accent']).toContain('0 0 20px');
  });
});

describe('themeToCssVars', () => {
  it('returns empty for null/undefined theme', () => {
    expect(themeToCssVars(null)).toEqual({});
    expect(themeToCssVars(undefined)).toEqual({});
  });

  it('applies palette tokens', () => {
    const vars = themeToCssVars({ palette: 'ember' });
    expect(vars['--color-canvas-hi']).toBe(PALETTES.ember['--color-canvas-hi']);
    expect(vars['--color-accent']).toBe(PALETTES.ember['--color-accent']);
  });

  it('accent override wins over palette accent but not canvas', () => {
    const vars = themeToCssVars({ palette: 'ember', accent: '#123456' });
    expect(vars['--color-accent']).toBe('#123456');
    expect(vars['--color-canvas-hi']).toBe(PALETTES.ember['--color-canvas-hi']);
  });

  it('sets the display font stack', () => {
    const vars = themeToCssVars({ displayFont: 'cinzel' });
    expect(vars['--font-display']).toBe(FONT_STACKS.cinzel);
  });
});
