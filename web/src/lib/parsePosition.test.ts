import { describe, it, expect } from 'vitest';
import { parsePosition } from './parsePosition';

describe('parsePosition', () => {
  it('accepts negative integers', () => {
    expect(parsePosition('-10000')).toEqual({ ok: true, value: -10000 });
  });

  it('accepts scientific notation', () => {
    expect(parsePosition('4.35e17')).toEqual({ ok: true, value: 4.35e17 });
  });

  it('accepts zero', () => {
    expect(parsePosition('0')).toEqual({ ok: true, value: 0 });
  });

  it('rejects empty string', () => {
    const r = parsePosition('');
    expect(r.ok).toBe(false);
    expect((r as { ok: false; error: string }).error).toBe('Required');
  });

  it('rejects whitespace-only', () => {
    const r = parsePosition('   ');
    expect(r.ok).toBe(false);
    expect((r as { ok: false; error: string }).error).toBe('Required');
  });

  it('rejects "10abc" (Number is strict, parseFloat would not be)', () => {
    const r = parsePosition('10abc');
    expect(r.ok).toBe(false);
  });

  it('rejects NaN literal', () => {
    expect(parsePosition('NaN').ok).toBe(false);
  });

  it('rejects Infinity literal', () => {
    expect(parsePosition('Infinity').ok).toBe(false);
  });

  it('trims whitespace before parsing', () => {
    expect(parsePosition('  42  ')).toEqual({ ok: true, value: 42 });
  });
});
