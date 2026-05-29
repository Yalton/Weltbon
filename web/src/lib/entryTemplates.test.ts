import { describe, it, expect } from 'vitest';
import { TEMPLATES, getTemplate, metaArrayToRecord, type EntryTemplate } from './entryTemplates';

describe('entryTemplates', () => {
  // Test 1: exactly 6 templates
  it('exports exactly 6 default templates', () => {
    expect(TEMPLATES).toHaveLength(6);
  });

  // Test 2: ids in exact order
  it('TEMPLATES ids match the v3.2 spec in order', () => {
    expect(TEMPLATES.map((t) => t.id)).toEqual([
      'character-detailed',
      'location-settlement',
      'magic-system',
      'religion',
      'conlang-word',
      'research-note',
    ]);
  });

  // Test 3: meta is an ordered array with 5-10 fields per D-08/D-09/D-12
  it('each template meta is an ordered array of 5-10 {name, default_value: string} fields', () => {
    for (const t of TEMPLATES) {
      expect(Array.isArray(t.meta), `${t.id} meta should be an array`).toBe(true);
      expect(
        t.meta.length,
        `${t.id} meta should have 5-10 fields, got ${t.meta.length}`,
      ).toBeGreaterThanOrEqual(5);
      expect(
        t.meta.length,
        `${t.id} meta should have at most 10 fields, got ${t.meta.length}`,
      ).toBeLessThanOrEqual(10);
      for (const field of t.meta) {
        expect(typeof field.name).toBe('string');
        expect(
          typeof field.default_value,
          `${t.id} field "${field.name}" default_value must be string (D-12)`,
        ).toBe('string');
      }
    }
  });

  // Test 4: body has at least 2 ## section headers per D-08
  it('each template body contains at least 2 markdown section headers (D-08)', () => {
    for (const t of TEMPLATES) {
      const matches = t.body.match(/^## /gm);
      expect(
        matches?.length ?? 0,
        `${t.id} body should have at least 2 ## headers, found ${matches?.length ?? 0}`,
      ).toBeGreaterThanOrEqual(2);
    }
  });

  // Test 5: entryType values match D-07 in TEMPLATES order
  it('entryType values match D-07 spec in TEMPLATES order', () => {
    expect(TEMPLATES.map((t) => t.entryType)).toEqual([
      'entity',
      'location',
      'magic-system',
      'religion',
      'conlang-word',
      'research-note',
    ]);
  });

  // Test 6: getTemplate lookup
  it('getTemplate returns the correct template or undefined', () => {
    const ms = getTemplate('magic-system');
    expect(ms).toBeDefined();
    expect(ms!.id).toBe('magic-system');
    expect(ms!.label).toBe('Magic-System');
    expect(getTemplate('does-not-exist')).toBeUndefined();
  });

  // Test 7: metaArrayToRecord round-trip
  it('metaArrayToRecord converts array to Record correctly', () => {
    expect(
      metaArrayToRecord([
        { name: 'a', default_value: '1' },
        { name: 'b', default_value: '' },
      ]),
    ).toEqual({ a: '1', b: '' });
  });

  // Test 8: metaArrayToRecord with empty input
  it('metaArrayToRecord with empty array returns empty object', () => {
    expect(metaArrayToRecord([])).toEqual({});
  });

  // Test 9 (regression): no duplicate ids
  it('TEMPLATES has no duplicate ids', () => {
    const ids = TEMPLATES.map((t) => t.id);
    const uniqueIds = new Set(ids);
    expect(uniqueIds.size).toBe(6);
  });

  // D-12 explicit: assert default_value is ALWAYS string, never number/Date/etc
  it('all meta field default_values are strings (D-12 typed-field deferral)', () => {
    for (const t of TEMPLATES) {
      for (const field of t.meta) {
        expect(
          typeof field.default_value === 'string',
          `${t.id}.meta["${field.name}"].default_value must be string, got ${typeof field.default_value}`,
        ).toBe(true);
      }
    }
  });
});
