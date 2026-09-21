import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';


// All paths are resolved against the web/ root (one level above /tests).
const WEB_ROOT = resolve(__dirname, '..');
const PUBLIC = resolve(WEB_ROOT, 'public');

const REQUIRED_FILES = [
  'favicon.svg',
  'favicon-16.png',
  'favicon-32.png',
  'favicon-48.png',
  'favicon-192.png',
  'favicon-512.png',
  'apple-touch-icon.png',
  'manifest.webmanifest',
];

describe('favicon + manifest assets', () => {
  it('all 8 required favicon/manifest files exist in /public', () => {
    for (const f of REQUIRED_FILES) {
      const p = resolve(PUBLIC, f);
      expect(existsSync(p), `${f} should exist at ${p}`).toBe(true);
      expect(statSync(p).size, `${f} should be non-empty`).toBeGreaterThan(0);
    }
  });

  it('favicon.svg has correct viewBox, a brand-color fill, and no scripts/strokes', () => {
    const svg = readFileSync(resolve(PUBLIC, 'favicon.svg'), 'utf8');
    expect(svg).toContain('viewBox="0 0 32 32"');
    // Accept either the OKLCH literal or the #7c5cff approximation.
    const hasOklchFill = svg.includes('oklch(0.6 0.18 270)');
    const hasHexFill = svg.includes('#7c5cff');
    expect(
      hasOklchFill || hasHexFill,
      'favicon.svg must include a brand-color fill (#7c5cff or oklch(0.6 0.18 270))',
    ).toBe(true);
    // Security/contract: no embedded scripts, no stroke attributes (fill-only spec).
    expect(svg).not.toContain('<script');
    expect(svg).not.toMatch(/\sstroke=/);
  });

  it('manifest.webmanifest parses as valid JSON with required fields', () => {
    const raw = readFileSync(resolve(PUBLIC, 'manifest.webmanifest'), 'utf8');
    const manifest = JSON.parse(raw) as {
      name: string;
      icons: Array<{ src: string; sizes: string; type: string }>;
    };
    expect(manifest.name).toBe('Weltbon');
    expect(Array.isArray(manifest.icons)).toBe(true);
    expect(manifest.icons.length).toBeGreaterThanOrEqual(2);
    const sizes = manifest.icons.map((i) => i.sizes);
    expect(sizes).toContain('192x192');
    expect(sizes).toContain('512x512');
  });
});
