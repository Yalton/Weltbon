import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';


const WEB_ROOT = resolve(__dirname, '..');
const html = readFileSync(resolve(WEB_ROOT, 'index.html'), 'utf8');

describe('index.html link + meta wiring', () => {
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

  it('declares exactly one theme-color meta with the dark-only background color', () => {
    const themeColorMetas = html.match(/<meta[^>]+name="theme-color"[^>]*>/g) ?? [];
    expect(themeColorMetas.length).toBe(1);
    expect(
      themeColorMetas[0],
      'expected the single theme-color meta to carry the dark-only color #070912',
    ).toMatch(/content="#070912"/);
  });
});
