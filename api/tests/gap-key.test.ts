
import { describe, it, expect } from 'vitest';
import { strictLexNormalize, computeGapKey } from '../src/services/gap-key.js';

const UID_A = '00000000-0000-0000-0000-000000000001';
const UID_B = '00000000-0000-0000-0000-000000000002';

describe('strictLexNormalize', () => {
  it('lowercases, trims, and strips punctuation from a simple string', () => {
    expect(strictLexNormalize('  Hello, World!  ')).toBe('hello world');
  });

  it('collapses multiple internal spaces to a single space', () => {
    expect(strictLexNormalize('Hello   World')).toBe('hello world');
  });

  it('strips non-ASCII and non-alphanumeric characters (NFC then strip)', () => {
    // Char-by-char trace on 'Café  über–straße':
    //   é (U+00E9) → stripped; spaces survive; ü (U+00FC) → stripped;
    //   – (en-dash U+2013) → stripped (no surrounding spaces, so ber+strae merge);
    //   ß (U+00DF) → stripped (no space between straße parts, so strae stays)
    //
    // After lowercase:  'café  über–straße'
    // After NFC:        same (all precomposed — no change)
    // After trim:       same
    // After strip:      'caf  berstrae'  (é→'', ü→'', –→'', ß→''; two spaces remain)
    // After collapse:   'caf berstrae'
    const result = strictLexNormalize('Café  über–straße');
    expect(result).toBe('caf berstrae');
  });

  it('reduces an all-punctuation + spaces input to just a single space', () => {
    // Spaces survive the strip step; collapse normalizes multiple spaces to one.
    expect(strictLexNormalize('!!!  ???')).toBe(' ');
  });

  it('handles already-clean lowercase alphanumeric input unchanged', () => {
    expect(strictLexNormalize('hello world 123')).toBe('hello world 123');
  });
});

describe('computeGapKey', () => {
  it('returns a string matching the /^v1:[0-9a-f]{16}$/ shape', () => {
    const key = computeGapKey(UID_A, 'missing-link', ['e1', 'e2'], 'Title');
    expect(key).toMatch(/^v1:[0-9a-f]{16}$/);
  });

  it('starts with the "v1:" prefix (D-12)', () => {
    const key = computeGapKey(UID_A, 'missing-link', ['e1'], 'Title');
    expect(key.startsWith('v1:')).toBe(true);
  });

  it('ref-order normalization: same result regardless of referencedEntryIds order', () => {
    const keyAB = computeGapKey(UID_A, 'missing-link', ['e1', 'e2'], 'Title');
    const keyBA = computeGapKey(UID_A, 'missing-link', ['e2', 'e1'], 'Title');
    expect(keyAB).toBe(keyBA);
  });

  it('title canonicalization: "Title" and "title!" both normalize to "title" → equal keys', () => {
    const keyTitle = computeGapKey(UID_A, 'missing-link', ['e1', 'e2'], 'Title');
    const keyBang = computeGapKey(UID_A, 'missing-link', ['e1', 'e2'], 'title!');
    expect(keyTitle).toBe(keyBang);
  });

  it('different-title inequality: "Title A" and "Title B" produce different keys', () => {
    const keyA = computeGapKey(UID_A, 'missing-link', ['e1', 'e2'], 'Title A');
    const keyB = computeGapKey(UID_A, 'missing-link', ['e1', 'e2'], 'Title B');
    expect(keyA).not.toBe(keyB);
  });

  it('cross-universe non-collision (D-08): same category/refs/title under different universeIds → different keys', () => {
    const keyA = computeGapKey(UID_A, 'missing-link', ['e1'], 'X');
    const keyB = computeGapKey(UID_B, 'missing-link', ['e1'], 'X');
    expect(keyA).not.toBe(keyB);
  });

  it('produces stable deterministic output across calls with identical inputs', () => {
    const key1 = computeGapKey(UID_A, 'underdeveloped', ['e1'], 'Stable Title');
    const key2 = computeGapKey(UID_A, 'underdeveloped', ['e1'], 'Stable Title');
    expect(key1).toBe(key2);
  });
});
