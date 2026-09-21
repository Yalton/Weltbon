export type ParsePositionResult =
  | { ok: true; value: number }
  | { ok: false; error: string };

export function parsePosition(input: string): ParsePositionResult {
  const trimmed = input.trim();
  if (trimmed === '') return { ok: false, error: 'Required' };
  const n = Number(trimmed);
  if (!Number.isFinite(n)) {
    return { ok: false, error: 'Must be a finite number (e.g. -10000, 4.35e17)' };
  }
  return { ok: true, value: n };
}
