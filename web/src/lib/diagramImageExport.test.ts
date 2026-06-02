/**
 * diagramImageExport unit tests (DIAGRAM-03 / Plan 10 TDD).
 *
 * Coverage:
 *   - serializeSvgElement: namespace, dimensions, child elements, round-trip-parse
 *   - serializeSvgElement: fill/stroke inlining
 *   - exportSvg: constructs Blob of type image/svg+xml and calls URL.createObjectURL
 *
 * PNG rasterization (Image.onload + canvas.toBlob) is NOT tested under jsdom
 * (no real pixel pipeline). The exportPng unit test only asserts the function
 * exists and is callable — full raster fidelity is verified in the human checkpoint.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { serializeSvgElement, exportSvg, exportPng } from './diagramImageExport';

// ─── Helpers ───────────────────────────────────────────────────────────────────

/** Build a minimal <svg> in jsdom for testing. */
function makeSvg(opts: { width?: number; height?: number } = {}): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('width', String(opts.width ?? 400));
  svg.setAttribute('height', String(opts.height ?? 300));

  const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
  circle.setAttribute('cx', '50');
  circle.setAttribute('cy', '50');
  circle.setAttribute('r', '20');
  circle.setAttribute('fill', '#ff0000');
  circle.setAttribute('stroke', '#000000');
  svg.appendChild(circle);

  const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
  line.setAttribute('x1', '0');
  line.setAttribute('y1', '0');
  line.setAttribute('x2', '100');
  line.setAttribute('y2', '100');
  line.setAttribute('stroke', '#3b82f6');
  svg.appendChild(line);

  const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
  text.setAttribute('x', '10');
  text.setAttribute('y', '20');
  text.textContent = 'Hello world';
  svg.appendChild(text);

  return svg;
}

// ─── serializeSvgElement ───────────────────────────────────────────────────────

describe('serializeSvgElement', () => {
  it('returns a string', () => {
    const svg = makeSvg();
    const result = serializeSvgElement(svg);
    expect(typeof result).toBe('string');
  });

  it('output contains xmlns="http://www.w3.org/2000/svg"', () => {
    const svg = makeSvg();
    const result = serializeSvgElement(svg);
    expect(result).toContain('xmlns="http://www.w3.org/2000/svg"');
  });

  it('output contains explicit width attribute', () => {
    const svg = makeSvg({ width: 800, height: 600 });
    const result = serializeSvgElement(svg);
    expect(result).toContain('width="800"');
  });

  it('output contains explicit height attribute', () => {
    const svg = makeSvg({ width: 800, height: 600 });
    const result = serializeSvgElement(svg);
    expect(result).toContain('height="600"');
  });

  it('output contains child elements (circle, line, text)', () => {
    const svg = makeSvg();
    const result = serializeSvgElement(svg);
    expect(result).toContain('<circle');
    expect(result).toContain('<line');
    expect(result).toContain('<text');
  });

  it('output contains text content from <text> child', () => {
    const svg = makeSvg();
    const result = serializeSvgElement(svg);
    expect(result).toContain('Hello world');
  });

  it('round-trip: DOMParser re-parses the output into an <svg> root', () => {
    const svg = makeSvg();
    const serialized = serializeSvgElement(svg);
    const parser = new DOMParser();
    // jsdom supports 'application/xml' but not 'image/svg+xml'.
    // Both parse the same SVG markup; 'application/xml' is equivalent for round-trip tests.
    const doc = parser.parseFromString(serialized, 'application/xml');
    const root = doc.documentElement;
    expect(root.tagName.toLowerCase()).toBe('svg');
  });

  it('round-trip: re-parsed <svg> has the same child count', () => {
    const svg = makeSvg(); // circle + line + text = 3 children
    const serialized = serializeSvgElement(svg);
    const parser = new DOMParser();
    // jsdom supports 'application/xml' but not 'image/svg+xml'.
    const doc = parser.parseFromString(serialized, 'application/xml');
    const root = doc.documentElement;
    // At least the 3 children we added (serializer may add xmlns attrs — child count same)
    expect(root.childNodes.length).toBe(svg.childNodes.length);
  });

  it('output contains a concrete fill color value from a child with fill attribute', () => {
    const svg = makeSvg();
    // The circle has fill="#ff0000"
    const result = serializeSvgElement(svg);
    // The fill value (#ff0000) must appear in the output — either as an attribute
    // or inlined style; the serializer must not strip it.
    expect(result).toContain('#ff0000');
  });

  it('output contains a concrete stroke color value from a child with stroke attribute', () => {
    const svg = makeSvg();
    // The line has stroke="#3b82f6"
    const result = serializeSvgElement(svg);
    expect(result).toContain('#3b82f6');
  });

  it('output contains a viewBox attribute (WR-03: content bbox, not viewport)', () => {
    // When getBBox() is unavailable (jsdom), the fallback sets viewBox from the
    // element's explicit width/height attributes. Either way, viewBox must be present.
    const svg = makeSvg({ width: 800, height: 600 });
    const result = serializeSvgElement(svg);
    expect(result).toContain('viewBox=');
  });

  it('g.viewport transform is neutralized in the clone (WR-03)', () => {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('width', '400');
    svg.setAttribute('height', '300');
    const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    g.setAttribute('class', 'viewport');
    g.setAttribute('transform', 'translate(50,30) scale(1.5)');
    svg.appendChild(g);

    const result = serializeSvgElement(svg, { inlineComputedStyles: false });
    // The clone's g.viewport must not retain the live pan/zoom transform.
    expect(result).not.toContain('translate(50,30)');
  });
});

// ─── exportSvg ────────────────────────────────────────────────────────────────

describe('exportSvg', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('calls URL.createObjectURL with a Blob of type image/svg+xml', async () => {
    const svg = makeSvg();

    // Spy on URL.createObjectURL
    const createObjectURLSpy = vi.fn().mockReturnValue('blob:test-svg');
    URL.createObjectURL = createObjectURLSpy;
    URL.revokeObjectURL = vi.fn();

    // Prevent jsdom navigation error from the anchor click
    const appendSpy = vi.spyOn(document.body, 'appendChild').mockImplementation((el) => el);
    const removeSpy = vi.spyOn(document.body, 'removeChild').mockImplementation((el) => el);

    exportSvg(svg, 'test-diagram');

    expect(createObjectURLSpy).toHaveBeenCalledOnce();
    const blob = createObjectURLSpy.mock.calls[0][0] as Blob;
    expect(blob).toBeInstanceOf(Blob);
    expect(blob.type).toBe('image/svg+xml');

    appendSpy.mockRestore();
    removeSpy.mockRestore();
  });

  it('triggers download via an anchor element with .svg extension', () => {
    const svg = makeSvg();

    URL.createObjectURL = vi.fn().mockReturnValue('blob:test-svg');
    URL.revokeObjectURL = vi.fn();

    let capturedAnchor: HTMLAnchorElement | null = null;
    const appendSpy = vi.spyOn(document.body, 'appendChild').mockImplementation((el) => {
      capturedAnchor = el as HTMLAnchorElement;
      return el;
    });
    vi.spyOn(document.body, 'removeChild').mockImplementation((el) => el);

    exportSvg(svg, 'my diagram');

    expect(capturedAnchor).not.toBeNull();
    expect((capturedAnchor as unknown as HTMLAnchorElement).download).toMatch(/\.svg$/);
    appendSpy.mockRestore();
  });
});

// ─── exportPng ────────────────────────────────────────────────────────────────

describe('exportPng', () => {
  it('is a callable function', () => {
    expect(typeof exportPng).toBe('function');
  });

  it('does not throw when called with a valid SVG element', () => {
    const svg = makeSvg();
    URL.createObjectURL = vi.fn().mockReturnValue('blob:test');
    URL.revokeObjectURL = vi.fn();

    // exportPng sets up Image.onload + canvas.toBlob — both are no-ops in jsdom.
    // We only assert no synchronous throw.
    expect(() => exportPng(svg, 'test')).not.toThrow();
  });

  it('calls onError when img.onerror fires (WR-01)', () => {
    const svg = makeSvg();
    URL.createObjectURL = vi.fn().mockReturnValue('blob:test');
    URL.revokeObjectURL = vi.fn();

    const onError = vi.fn();

    // Intercept Image construction and immediately fire onerror.
    const OrigImage = globalThis.Image;
    class ErrorImage {
      onload: (() => void) | null = null;
      onerror: ((evt: unknown) => void) | null = null;
      set src(_url: string) {
        // Simulate failed rasterization
        this.onerror?.(new Error('rasterization failed'));
      }
    }
    // @ts-expect-error — patching global for test
    globalThis.Image = ErrorImage;

    exportPng(svg, 'test', { onError });

    expect(onError).toHaveBeenCalledOnce();

    globalThis.Image = OrigImage;
  });
});
