export type ParsePositionResult =
  | { ok: true; value: number }
  | { ok: false; error: string };

/**
 * Strict float parsing for timeline pin positions.
 *
 * Uses Number() (not parseFloat) so that strings like "10abc" are rejected.
 * Trims surrounding whitespace, rejects empty input as "Required", and
 * rejects NaN / Infinity as not-finite. The error string is consumed verbatim
 * by PinEditor's inline validation message.
 *
 * Pure function: no React, no DOM, no side effects.
 */
export function parsePosition(input: string): ParsePositionResult {
  const trimmed = input.trim();
  if (trimmed === '') return { ok: false, error: 'Required' };
  const n = Number(trimmed);
  if (!Number.isFinite(n)) {
    return { ok: false, error: 'Must be a finite number (e.g. -10000, 4.35e17)' };
  }
  return { ok: true, value: n };
}
