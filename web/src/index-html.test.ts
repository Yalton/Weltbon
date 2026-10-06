import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const html = readFileSync(resolve(process.cwd(), 'index.html'), 'utf8');
const doc = new DOMParser().parseFromString(html, 'text/html');
const meta = (selector: string) => doc.querySelector(selector)?.getAttribute('content') ?? '';

describe('index.html', () => {
  it('describes Weltbon for search results and link previews', () => {
    expect(meta('meta[name="description"]')).toMatch(/worldbuilding/i);
    expect(meta('meta[property="og:title"]')).toBe('Weltbon');
    expect(meta('meta[property="og:description"]')).toBe(meta('meta[name="description"]'));
    expect(meta('meta[property="og:type"]')).toBe('website');
  });

  it('starts dark without an inline script, so the CSP can forbid inline scripts', () => {
    expect(doc.documentElement.classList.contains('dark')).toBe(true);
    const inline = [...doc.querySelectorAll('script')].filter((s) => !s.getAttribute('src'));
    expect(inline).toHaveLength(0);
  });
});
