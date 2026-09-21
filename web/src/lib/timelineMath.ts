
export const posToX = (
  pos: number,
  windowStart: number,
  windowEnd: number,
  canvasWidth: number,
): number => ((pos - windowStart) / (windowEnd - windowStart)) * canvasWidth;

export const clampXToCanvas = (x: number, canvasWidth: number): number =>
  Math.min(canvasWidth, Math.max(0, x));

export const xToPos = (
  x: number,
  windowStart: number,
  windowEnd: number,
  canvasWidth: number,
): number =>
  (clampXToCanvas(x, canvasWidth) / canvasWidth) *
    (windowEnd - windowStart) +
  windowStart;

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
