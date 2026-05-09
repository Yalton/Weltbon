import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// POL-04 Task 1 — styles.css static contract: motion tokens, keyframes,
// prose block, and reduced-motion-last ordering.
const WEB_ROOT = resolve(__dirname, '..');
const css = readFileSync(resolve(WEB_ROOT, 'src/styles.css'), 'utf8');

describe('styles.css contract (POL-04 Task 1)', () => {
  it('declares the required motion + sim CSS custom-property tokens', () => {
    expect(css).toContain('--motion-ease-out');
    expect(css).toContain('--motion-ease-in');
    expect(css).toContain('--motion-dialog-enter-duration');
    expect(css).toContain('--sim-line-opacity-dark');
  });

  it('declares the 6 dialog/popover/fade @keyframes', () => {
    const required = [
      'dialog-in',
      'dialog-out',
      'popover-in',
      'popover-out',
      'fade-in',
      'fade-out',
    ];
    for (const name of required) {
      const re = new RegExp(`@keyframes\\s+${name}\\b`);
      expect(re.test(css), `expected @keyframes ${name}`).toBe(true);
    }
  });

  it('declares the 3 --animate-* utility tokens consumed by data-[state] classes', () => {
    expect(css).toContain('--animate-dialog-in');
    expect(css).toContain('--animate-popover-in');
    expect(css).toContain('--animate-overlay-in');
  });

  it('defines the .prose and .dark .prose typography blocks', () => {
    // Use word-boundary-ish checks tolerant of selector spacing.
    expect(/\.prose\s*\{/.test(css)).toBe(true);
    expect(/\.dark\s+\.prose\s*\{/.test(css)).toBe(true);
  });

  it('places the prefers-reduced-motion block AFTER the last @keyframes (ordering invariant)', () => {
    const reducedIdx = css.indexOf('prefers-reduced-motion');
    expect(reducedIdx, 'prefers-reduced-motion must appear in styles.css').toBeGreaterThan(-1);
    const lastKeyframesIdx = css.lastIndexOf('@keyframes');
    expect(lastKeyframesIdx).toBeGreaterThan(-1);
    expect(
      reducedIdx,
      'prefers-reduced-motion block must come after the final @keyframes declaration',
    ).toBeGreaterThan(lastKeyframesIdx);
  });
});
