/**
 * A-05 — the manifest universe row has ONE definition.
 *
 * `buildManifest` (the export/sync manifest) and the sync discovery route both
 * emit this row, and adoption feeds it straight into `applyManifestOps`. A
 * field dropped here is a field the adopted universe LOSES, and then pushes as
 * a loss over the remote's good row on the very first sync. So the field set is
 * pinned: adding or removing one must break this test and force the decision.
 */
import { describe, it, expect } from 'vitest';
import { buildUniverseManifestRow } from '../src/services/export/json.js';

const ROW = {
  id: '11111111-1111-4111-8111-111111111111',
  name: 'Aethel',
  description: 'a place',
  entryTypes: ['character', 'place'],
  timelineWindow: { start: 0, end: 100 },
  linkTypes: { ally: { color: '#fff' } },
  calendar: { months: [] },
  theme: { accent: '#abcdef' },
  fieldRegistry: [{ key: 'age', type: 'number' }],
  auditEnabled: true,
  auditProvider: 'anthropic',
  auditModel: 'claude-opus-5',
  createdAt: new Date('2026-01-02T03:04:05.000Z'),
  updatedAt: new Date('2026-02-03T04:05:06.000Z'),
} as any;

describe('buildUniverseManifestRow (A-05)', () => {
  it('emits exactly the 14 manifest universe fields', () => {
    expect(Object.keys(buildUniverseManifestRow(ROW)).sort()).toEqual(
      [
        'auditEnabled', 'auditModel', 'auditProvider', 'calendar', 'createdAt',
        'description', 'entryTypes', 'fieldRegistry', 'id', 'linkTypes', 'name',
        'theme', 'timelineWindow', 'updatedAt',
      ].sort(),
    );
  });

  it('carries the fields a hand-rolled row would quietly drop', () => {
    const row = buildUniverseManifestRow(ROW);
    expect(row.theme).toEqual({ accent: '#abcdef' });
    expect(row.calendar).toEqual({ months: [] });
    expect(row.fieldRegistry).toEqual([{ key: 'age', type: 'number' }]);
    expect(row.linkTypes).toEqual({ ally: { color: '#fff' } });
    expect(row.timelineWindow).toEqual({ start: 0, end: 100 });
  });

  it('serializes timestamps as ISO strings, not Dates', () => {
    const row = buildUniverseManifestRow(ROW);
    expect(row.createdAt).toBe('2026-01-02T03:04:05.000Z');
    expect(row.updatedAt).toBe('2026-02-03T04:05:06.000Z');
  });
});
