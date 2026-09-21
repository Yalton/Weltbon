/**
 * diagramImageExport — SVG serialization + browser SVG/PNG download helpers.
 *
 *
 * Security notes:
 *   T-31-25: serialization uses XMLSerializer on the app's own DOM nodes — text
 *   never string-concatenate raw label text into markup.
 *   T-31-26: the canvas SVG contains no external image references (only vector
 *   shapes + text), so canvas.toBlob stays untainted.
 *
 * Zero new dependencies — uses only browser SVG/Image/canvas APIs.
 * The download mechanism (URL.createObjectURL + transient <a download>) is
 */


export const DEFAULT_SCALE = 2;

export const MAX_CANVAS_DIMENSION = 8192;

// into the clone so the PNG raster matches the on-screen render.
const INLINE_STYLE_PROPS: readonly string[] = [
  'fill',
  'stroke',
  'stroke-width',
  'stroke-dasharray',
  'stroke-opacity',
  'fill-opacity',
  'opacity',
  'font-size',
  'font-family',
  'font-weight',
  'text-anchor',
  'dominant-baseline',
];


function sanitizeFilename(name: string): string {
  return name.replace(/[^a-z0-9.\-]/gi, '_').toLowerCase();
}

function inlineStylesFromOriginal(original: Element, clone: Element): void {
  const computedStyle = window.getComputedStyle(original);

  for (const prop of INLINE_STYLE_PROPS) {
    const value = computedStyle.getPropertyValue(prop);
    // WR-04: only skip empty string — do NOT filter 'none', 'normal', or '0px'
    // blanket-wide, since those are legitimate SVG presentation values.
    if (value !== '') {
      clone.setAttribute(prop, value);
    }
  }

  const origChildren = Array.from(original.children);
  const cloneChildren = Array.from(clone.children);
  const len = Math.min(origChildren.length, cloneChildren.length);
  for (let i = 0; i < len; i++) {
    inlineStylesFromOriginal(origChildren[i], cloneChildren[i]);
  }
}


export interface SerializeSvgOptions {
  inlineComputedStyles?: boolean;
}

export function serializeSvgElement(
  svgEl: SVGSVGElement,
  opts: SerializeSvgOptions = {},
): string {
  const { inlineComputedStyles = true } = opts;

  const clone = svgEl.cloneNode(true) as SVGSVGElement;

  const hasXmlns = clone.hasAttribute('xmlns') || clone.namespaceURI === 'http://www.w3.org/2000/svg';
  if (!hasXmlns) {
    clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  }

  // WR-03: Compute content bounding box from the live element tree.
  // The SVG uses a <g class="viewport"> that carries the d3-zoom pan/zoom
  // the un-transformed SVG coordinate space), not the viewport dimensions.
  const EXPORT_PADDING = 24; // px padding around the content bbox
  let bboxX = 0;
  let bboxY = 0;
  let bboxW = 0;
  let bboxH = 0;

  try {
    const viewportG = svgEl.querySelector<SVGGElement>('g.viewport');
    const rawBBox = viewportG ? viewportG.getBBox() : svgEl.getBBox();
    if (rawBBox && rawBBox.width > 0 && rawBBox.height > 0) {
      bboxX = rawBBox.x - EXPORT_PADDING;
      bboxY = rawBBox.y - EXPORT_PADDING;
      bboxW = rawBBox.width + EXPORT_PADDING * 2;
      bboxH = rawBBox.height + EXPORT_PADDING * 2;
    }
  } catch {
    // Fall through to viewport-size fallback below.
  }

  if (bboxW === 0 || bboxH === 0) {
    const srcWidth = svgEl.getAttribute('width');
    const srcHeight = svgEl.getAttribute('height');
    bboxW =
      srcWidth && srcWidth !== '0'
        ? Number(srcWidth)
        : svgEl.clientWidth || svgEl.getBoundingClientRect().width || 400;
    bboxH =
      srcHeight && srcHeight !== '0'
        ? Number(srcHeight)
        : svgEl.clientHeight || svgEl.getBoundingClientRect().height || 300;
  }

  clone.setAttribute('width', String(Math.round(bboxW)));
  clone.setAttribute('height', String(Math.round(bboxH)));
  clone.setAttribute('viewBox', `${bboxX} ${bboxY} ${bboxW} ${bboxH}`);

  const cloneViewportG = clone.querySelector<SVGGElement>('g.viewport');
  if (cloneViewportG) {
    cloneViewportG.removeAttribute('transform');
  }

  if (inlineComputedStyles) {
    inlineStylesFromOriginal(svgEl, clone);
  }

  // Serialize via XMLSerializer (never string-concat user content — T-31-25).
  const serializer = new XMLSerializer();
  return serializer.serializeToString(clone);
}


function triggerDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}


export function exportSvg(svgEl: SVGSVGElement, name: string, onError?: (err: unknown) => void): void {
  try {
    const svgString = serializeSvgElement(svgEl);
    const blob = new Blob([svgString], { type: 'image/svg+xml' });
    triggerDownload(blob, `${sanitizeFilename(name)}.svg`);
  } catch (err) {
    onError?.(err);
  }
}


export interface ExportPngOptions {
  scale?: number;
  onError?: (err: unknown) => void;
}

/**
 * Rasterizes the rendered diagram to a PNG and downloads it.
 *
 * Steps:
 *   1. Serialize the SVG to a string via `serializeSvgElement`.
 *   2. Construct a data URL from the serialized string.
 *   3. Load the data URL into an `<img>` element (triggers the browser's SVG
 *      rasterizer — no external library).
 *   4. On load, draw the image onto an offscreen `<canvas>` sized to
 *      `width * scale` × `height * scale`.
 *   5. `canvas.toBlob('image/png')` produces the final blob; download it.
 *
 * Security (T-31-26): the SVG is built from the app's own DOM; it contains no
 * external image references, so the canvas remains untainted and `toBlob` succeeds.
 *
 * Note: full rasterization (Image.onload + canvas.toBlob) is not reliably
 * exercisable under jsdom. This function is unit-tested for "no synchronous throw"
 * only; pixel-fidelity is verified in the human checkpoint.
 *
 * @param svgEl    The live canvas <svg> element to rasterize.
 * @param name     The desired base name (without extension). Will be sanitized.
 * @param opts     Optional settings (scale factor).
 */
export function exportPng(
  svgEl: SVGSVGElement,
  name: string,
  opts: ExportPngOptions = {},
): void {
  const scale = opts.scale ?? DEFAULT_SCALE;
  const { onError } = opts;

  let svgString: string;
  try {
    svgString = serializeSvgElement(svgEl);
  } catch (err) {
    onError?.(err);
    return;
  }

  // WR-03: resolve dimensions from the serialized SVG's width/height attributes
  let w = 400;
  let h = 300;
  try {
    const parser = new DOMParser();
    const parsed = parser.parseFromString(svgString, 'image/svg+xml');
    const parsedSvg = parsed.documentElement;
    const pw = Number(parsedSvg.getAttribute('width'));
    const ph = Number(parsedSvg.getAttribute('height'));
    if (pw > 0) w = pw;
    if (ph > 0) h = ph;
  } catch {
  }
  const sanitized = sanitizeFilename(name);

  const encoded = encodeURIComponent(svgString);
  const dataUrl = `data:image/svg+xml;charset=utf-8,${encoded}`;

  const img = new Image();
  img.onload = () => {
    const canvas = document.createElement('canvas');
    // WR-02: clamp canvas dimensions to MAX_CANVAS_DIMENSION to avoid exceeding
    // per-browser max canvas size (~16384 px), which causes toBlob to return null.
    const rawW = w * scale;
    const rawH = h * scale;
    const clampRatio = Math.min(1, MAX_CANVAS_DIMENSION / Math.max(rawW, rawH, 1));
    canvas.width = Math.round(rawW * clampRatio);
    canvas.height = Math.round(rawH * clampRatio);

    const ctx = canvas.getContext('2d');
    if (!ctx) {
      onError?.(new Error('Could not get 2d canvas context'));
      return;
    }

    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

    canvas.toBlob(
      (blob) => {
        if (!blob) {
          onError?.(new Error('canvas.toBlob produced null — canvas may exceed browser size limits'));
          return;
        }
        triggerDownload(blob, `${sanitized}.png`);
      },
      'image/png',
    );
  };
  // WR-01: surface rasterization errors to the caller instead of silently hanging.
  img.onerror = (evt) => {
    onError?.(evt instanceof Error ? evt : new Error('SVG rasterization failed'));
  };
  img.src = dataUrl;
}
