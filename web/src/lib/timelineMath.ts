/**
 * Pure linear interpolation between a timeline `position` (abstract numeric,
 * possibly negative, possibly scientific-notation magnitude) and a canvas
 * x-coordinate within `[0, canvasWidth]`.
 *
 * Per CONTEXT.md §D-07: one pixel = `(end - start) / canvasWidth` units.
 * No `d3-scale` dependency — the math is two lines. No DOM, no React, no
 * module-level side effects.
 *
 * Caller contract: `windowStart < windowEnd`. Equal or inverted windows
 * produce `NaN` / `Infinity` (enforced upstream by the configure-range
 * dialog's `parsePosition` validation).
 */

/**
 * Map a `position` to a canvas x-coordinate via linear interpolation within
 * `[windowStart, windowEnd]`. Returns negative or > canvasWidth values for
 * out-of-window positions; callers wanting clamping should use
 * `clampedPosToX` instead.
 */
export const posToX = (
  pos: number,
  windowStart: number,
  windowEnd: number,
  canvasWidth: number,
): number => ((pos - windowStart) / (windowEnd - windowStart)) * canvasWidth;

/**
 * Clamp an x-coordinate to the usable horizontal extent of the canvas.
 * Drag events can continue reporting pointer coordinates after the pointer
 * leaves the SVG; persisting those raw values is what allowed pins to become
 * unreachable outside the configured timeline window (#46).
 */
export const clampXToCanvas = (x: number, canvasWidth: number): number =>
  Math.min(canvasWidth, Math.max(0, x));

/**
 * Exact inverse of `posToX` for `x in [0, canvasWidth]`: map a canvas
 * x-coordinate back to a `position` value. Out-of-canvas x values clamp to
 * the configured start/end so every drag caller gets the same safe boundary
 * behavior, including coordinates inverted through a zoom transform.
 */
export const xToPos = (
  x: number,
  windowStart: number,
  windowEnd: number,
  canvasWidth: number,
): number =>
  (clampXToCanvas(x, canvasWidth) / canvasWidth) *
    (windowEnd - windowStart) +
  windowStart;

/**
 * Same mapping as `posToX`, but clamps out-of-window positions to the
 * nearest canvas edge and reports the clamp state. Used by the canvas
 * out-of-range indicator (D-03): pins with positions outside the configured
 * `[start, end]` window render at the nearest edge with a "beyond range"
 * marker rather than off-canvas.
 *
 * Edge positions (`pos === windowStart` or `pos === windowEnd`) are
 * considered in-range (`clamped: false`) and produce x=0 or x=width
 * respectively.
 */
export const clampedPosToX = (
  pos: number,
  windowStart: number,
  windowEnd: number,
  canvasWidth: number,
): { x: number; clamped: boolean } => {
  if (pos < windowStart) return { x: 0, clamped: true };
  if (pos > windowEnd) return { x: canvasWidth, clamped: true };
  return { x: posToX(pos, windowStart, windowEnd, canvasWidth), clamped: false };
};
