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
 * Exact inverse of `posToX` for `x in [0, canvasWidth]`: map a canvas
 * x-coordinate back to a `position` value. Used by drag-end handlers to
 * translate cursor x into the abstract numeric position the user is
 * dropping a pin at.
 */
export const xToPos = (
  x: number,
  windowStart: number,
  windowEnd: number,
  canvasWidth: number,
): number => (x / canvasWidth) * (windowEnd - windowStart) + windowStart;

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
