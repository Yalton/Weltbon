import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// POL-01 Task 3 — index.html link/meta wiring contract.
const WEB_ROOT = resolve(__dirname, '..');
const html = readFileSync(resolve(WEB_ROOT, 'index.html'), 'utf8');

describe('index.html link + meta wiring (POL-01 Task 3)', () => {
  it('declares at least 4 <link rel="icon"> entries (svg + multi-size png)', () => {
    const matches = html.match(/<link[^>]+rel="icon"[^>]*>/g) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(4);
  });

  it('declares exactly one <link rel="manifest">', () => {
    const matches = html.match(/<link[^>]+rel="manifest"[^>]*>/g) ?? [];
    expect(matches.length).toBe(1);
  });

  it('declares exactly one <link rel="apple-touch-icon">', () => {
    const matches = html.match(/<link[^>]+rel="apple-touch-icon"[^>]*>/g) ?? [];
    expect(matches.length).toBe(1);
  });

  it('declares two theme-color metas, one each for light + dark color scheme', () => {
    const themeColorMetas = html.match(/<meta[^>]+name="theme-color"[^>]*>/g) ?? [];
    expect(themeColorMetas.length).toBe(2);
    const hasDark = themeColorMetas.some((m) =>
      /media="\(prefers-color-scheme:\s*dark\)"/.test(m),
    );
    const hasLight = themeColorMetas.some((m) =>
      /media="\(prefers-color-scheme:\s*light\)"/.test(m),
    );
    expect(hasDark, 'expected a theme-color meta for prefers-color-scheme: dark').toBe(true);
    expect(hasLight, 'expected a theme-color meta for prefers-color-scheme: light').toBe(true);
  });
});
