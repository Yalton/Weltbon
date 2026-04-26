import { describe, it, expect } from 'vitest';
import { TEMPLATES, TEMPLATE_GROUPS, getTemplate } from './entryTemplates';

describe('entryTemplates', () => {
  it('exports exactly 10 templates (9 builtin types + Blank)', () => {
    expect(TEMPLATES).toHaveLength(10);
  });

  it('includes the 9 default builtin entry types plus blank', () => {
    const ids = TEMPLATES.map((t) => t.id);
    const expected = [
      'blank',
      'concept',
      'entity',
      'location',
      'event',
      'faction',
      'artifact',
      'species',
      'culture',
      'thread',
    ];
    for (const id of expected) {
      expect(ids).toContain(id);
    }
  });

  it('Blank template has empty body and meta and entryType', () => {
    const blank = getTemplate('blank');
    expect(blank).toBeDefined();
    expect(blank!.body).toBe('');
    expect(blank!.meta).toEqual({});
    expect(blank!.entryType).toBe('');
  });

  it('Location template has Geography section and worldbuilder meta keys', () => {
    const loc = getTemplate('location');
    expect(loc).toBeDefined();
    expect(loc!.body).toContain('## Geography');
    expect(Object.keys(loc!.meta)).toEqual(
      expect.arrayContaining(['region', 'climate', 'population']),
    );
    expect(loc!.entryType).toBe('location');
  });

  it('getTemplate(unknown) returns undefined', () => {
    expect(getTemplate('does-not-exist')).toBeUndefined();
  });

  it('TEMPLATE_GROUPS has 5 categories and templates sum to 10', () => {
    expect(TEMPLATE_GROUPS).toHaveLength(5);
    const labels = TEMPLATE_GROUPS.map((g) => g.label);
    expect(labels).toEqual(['Setting', 'People', 'Things', 'Time', 'Other']);
    const total = TEMPLATE_GROUPS.reduce((sum, g) => sum + g.templates.length, 0);
    expect(total).toBe(10);
  });

  it('every template has a non-empty label and description', () => {
    for (const t of TEMPLATES) {
      expect(t.label.length).toBeGreaterThan(0);
      expect(t.description?.length ?? 0).toBeGreaterThan(0);
    }
  });
});
