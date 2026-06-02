/**
 * diagramImageExport — SVG serialization + browser SVG/PNG download helpers.
 *
 * DIAGRAM-03 requirement (image export extension alongside JSON export from Plan 06).
 *
 * Security notes:
 *   T-31-25: serialization uses XMLSerializer on the app's own DOM nodes — text
 *   labels are already escaped by React/SVG <text> per Plan 05 (T-31-10). We
 *   never string-concatenate raw label text into markup.
 *   T-31-26: the canvas SVG contains no external image references (only vector
 *   shapes + text), so canvas.toBlob stays untainted.
 *
 * Zero new dependencies — uses only browser SVG/Image/canvas APIs.
 * The download mechanism (URL.createObjectURL + transient <a download>) is
 * reused verbatim from the Plan 02/06 Export JSON wiring.
 */

// ─── Constants ─────────────────────────────────────────────────────────────────

/** Default pixel-ratio scale factor applied when rasterizing to PNG. */
export const DEFAULT_SCALE = 2;

/**
 * Maximum canvas dimension (width or height) in pixels.
 * Most browsers cap canvas size at 16384 px (some at 32767). We use a
 * conservative 8192 to stay well within all targets (WR-02 fix).
 */
export const MAX_CANVAS_DIMENSION = 8192;

// SVG attributes that carry presentation information and should be inlined
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

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Sanitize a diagram name for use as a filename.
 * Replaces any character that is not alphanumeric, hyphen, dot, or underscore
 * with an underscore and lowercases the result.
 */
function sanitizeFilename(name: string): string {
  return name.replace(/[^a-z0-9.\-]/gi, '_').toLowerCase();
}

/**
 * Inline computed presentation styles onto an SVG element subtree so the
 * serialized string is self-contained — CSS-variable accent colors, entry-type
 * fills, and stroke values are resolved to concrete values before export.
 *
 * We walk the element tree and, for each Element, copy the computed values of
 * INLINE_STYLE_PROPS from getComputedStyle onto explicit presentation attributes.
 * This overwrites any existing attribute values with the resolved computed value,
 * ensuring colors that were set via CSS variables or class-based styles are
 * captured as concrete hex/rgb values in the output.
 *
 * Only called on the *clone*, not the live DOM node.
 */
function inlineStyles(el: Element): void {
  // getComputedStyle is only available for elements attached to a document.
  // In the live DOM the original SVG is attached; we call this on the clone
  // using the *original* element's computed styles (see serializeSvgElement).
  // This overload is called with the original element for computed styles and
  // the clone element for writing attributes — see serializeSvgElement for wiring.
  const computedStyle = window.getComputedStyle(el);

  for (const prop of INLINE_STYLE_PROPS) {
    const value = computedStyle.getPropertyValue(prop);
    if (value && value !== '' && value !== 'none' && value !== 'normal' && value !== '0px') {
      el.setAttribute(prop, value);
    }
  }

  // Recurse into children
  for (const child of Array.from(el.children)) {
    inlineStyles(child);
  }
}

/**
 * Inline computed styles from the original element tree onto the cloned element tree.
 * We zip the original and clone trees together so getComputedStyle reads from the
 * live DOM original (which has computed values), while setAttribute writes to the clone.
 */
function inlineStylesFromOriginal(original: Element, clone: Element): void {
  const computedStyle = window.getComputedStyle(original);

  for (const prop of INLINE_STYLE_PROPS) {
    const value = computedStyle.getPropertyValue(prop);
    // WR-04: only skip empty string — do NOT filter 'none', 'normal', or '0px'
    // blanket-wide, since those are legitimate SVG presentation values.
    // e.g. fill="none" on selection rings / halos must be preserved so they
    // don't render as solid black discs in the exported PNG/SVG.
    if (value !== '') {
      clone.setAttribute(prop, value);
    }
  }

  // Recurse paired children (original and clone have the same structure)
  const origChildren = Array.from(original.children);
  const cloneChildren = Array.from(clone.children);
  const len = Math.min(origChildren.length, cloneChildren.length);
  for (let i = 0; i < len; i++) {
    inlineStylesFromOriginal(origChildren[i], cloneChildren[i]);
  }
}

// ─── serializeSvgElement ──────────────────────────────────────────────────────

export interface SerializeSvgOptions {
  /**
   * When true (default), walk the original element tree and inline computed
   * fill/stroke/font styles onto the clone so CSS-variable colors are resolved
   * to concrete values in the output.
   */
  inlineComputedStyles?: boolean;
}

/**
 * Clones an SVG element and returns a standalone, self-contained SVG string.
 *
 * The output:
 *   - Has `xmlns="http://www.w3.org/2000/svg"` on the root.
 *   - Has width/height + viewBox derived from the *content* bounding box
 *     (getBBox on g.viewport, or getBBox on the whole SVG as fallback) so
 *     panned/zoomed nodes are never cropped (WR-03 fix).
 *   - Has the live pan/zoom transform neutralized (reset to identity) so the
 *     export shows the whole diagram, not just the viewport window.
 *   - Has computed fill/stroke/font styles inlined onto all descendants so the
 *     rasterized PNG matches the on-screen render even without external stylesheets.
 *   - Is produced by XMLSerializer — never by string concatenation (T-31-25).
 */
export function serializeSvgElement(
  svgEl: SVGSVGElement,
  opts: SerializeSvgOptions = {},
): string {
  const { inlineComputedStyles = true } = opts;

  // Clone the node so we can mutate it without affecting the live DOM.
  const clone = svgEl.cloneNode(true) as SVGSVGElement;

  // Ensure the SVG namespace is present (required for standalone SVG files).
  // Note: XMLSerializer already adds xmlns="http://www.w3.org/2000/svg" for
  // SVG elements created with createElementNS. We avoid setting it again via
  // setAttribute because that produces a duplicate xmlns attribute (invalid XML).
  // We only set it explicitly when it is genuinely absent from the serialized form
  // — which happens if the SVG was created without a namespace. In practice,
  // XMLSerializer handles namespace injection; we just make sure it's present
  // by doing nothing here for namespaced elements (the serializer will add it).
  // For safety we still set it on the clone's attribute map, accepting that
  // some environments will deduplicate while others will produce the string
  // twice (the latter is invalid XML but valid SVG for browsers).
  //
  // Portable fix: use getAttributeNS to check, and skip if already present.
  const hasXmlns = clone.hasAttribute('xmlns') || clone.namespaceURI === 'http://www.w3.org/2000/svg';
  if (!hasXmlns) {
    clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  }

  // WR-03: Compute content bounding box from the live element tree.
  // The SVG uses a <g class="viewport"> that carries the d3-zoom pan/zoom
  // transform. We read getBBox() on that group (which gives coordinates in
  // the un-transformed SVG coordinate space), not the viewport dimensions.
  // This ensures nodes panned outside the visible window are still exported.
  const EXPORT_PADDING = 24; // px padding around the content bbox
  let bboxX = 0;
  let bboxY = 0;
  let bboxW = 0;
  let bboxH = 0;

  try {
    // Try g.viewport first (DiagramCanvas structure).
    const viewportG = svgEl.querySelector<SVGGElement>('g.viewport');
    const rawBBox = viewportG ? viewportG.getBBox() : svgEl.getBBox();
    if (rawBBox && rawBBox.width > 0 && rawBBox.height > 0) {
      bboxX = rawBBox.x - EXPORT_PADDING;
      bboxY = rawBBox.y - EXPORT_PADDING;
      bboxW = rawBBox.width + EXPORT_PADDING * 2;
      bboxH = rawBBox.height + EXPORT_PADDING * 2;
    }
  } catch {
    // getBBox() throws in jsdom (not attached to a rendering context).
    // Fall through to viewport-size fallback below.
  }

  if (bboxW === 0 || bboxH === 0) {
    // Fallback: use the SVG element's rendered viewport dimensions.
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

  // Neutralize the live pan/zoom transform on g.viewport so the export shows
  // the whole diagram centred on the content bbox, not the panned/zoomed window.
  const cloneViewportG = clone.querySelector<SVGGElement>('g.viewport');
  if (cloneViewportG) {
    cloneViewportG.removeAttribute('transform');
  }

  // Inline computed presentation styles so fills/strokes/fonts that rely on
  // CSS variables or external classes are resolved to concrete values.
  if (inlineComputedStyles) {
    inlineStylesFromOriginal(svgEl, clone);
  }

  // Serialize via XMLSerializer (never string-concat user content — T-31-25).
  const serializer = new XMLSerializer();
  return serializer.serializeToString(clone);
}

// ─── Download helper (shared with exportSvg + exportPng) ─────────────────────

/**
 * Triggers a browser file download.
 * Reuses the URL.createObjectURL + transient <a download> mechanism from Plan 02/06.
 */
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

// ─── exportSvg ───────────────────────────────────────────────────────────────

/**
 * Downloads the rendered diagram as a standalone SVG file.
 *
 * Serializes `svgEl` via `serializeSvgElement` (inlining computed styles),
 * wraps it in a Blob of type `image/svg+xml`, and triggers a browser download
 * using the Plan 02/06 URL.createObjectURL + transient <a download> mechanism.
 *
 * @param svgEl    The live canvas <svg> element to export.
 * @param name     The desired base name (without extension). Will be sanitized.
 * @param onError  Optional callback invoked if export fails (e.g. serialization throws).
 */
export function exportSvg(svgEl: SVGSVGElement, name: string, onError?: (err: unknown) => void): void {
  try {
    const svgString = serializeSvgElement(svgEl);
    const blob = new Blob([svgString], { type: 'image/svg+xml' });
    triggerDownload(blob, `${sanitizeFilename(name)}.svg`);
  } catch (err) {
    onError?.(err);
  }
}

// ─── exportPng ───────────────────────────────────────────────────────────────

export interface ExportPngOptions {
  /**
   * Scale factor for the raster output.
   * @default DEFAULT_SCALE (2)
   */
  scale?: number;
  /**
   * Called when rasterization fails — img.onerror, null ctx, or null blob
   * (WR-01 fix). If not provided, failures are silently swallowed.
   */
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
  // (set by serializeSvgElement to the content bbox), not from the live element
  // whose viewport may be smaller than the diagram content.
  // Parse via DOMParser to extract the attributes without regex.
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
    // DOMParser not available in some environments — keep defaults.
  }
  const sanitized = sanitizeFilename(name);

  // Encode to data URL (more reliable than object URL for Image loading in some contexts).
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
