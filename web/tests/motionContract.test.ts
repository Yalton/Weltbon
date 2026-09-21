import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';


// must be present on the dialog/popover/overlay surfaces enumerated in

const SRC = resolve(__dirname, '..', 'src');
const read = (rel: string) => readFileSync(resolve(SRC, rel), 'utf8');

const DIALOG_CANDIDATES = [
  'components/ImportDialog.tsx',
  'components/PinEditor.tsx',
  'components/ConfirmDialog.tsx',
  'components/TemplatePicker.tsx',
  'components/CategoryManageDialog.tsx',
  'views/EntryEditor.tsx',
];

const POPOVER_CANDIDATES = [
  'components/ExportMenu.tsx',
  'components/RelationCombobox.tsx',
  'components/Sidebar.tsx',
];

describe('motion contract', () => {
  it('at least 4 of 6 dialog surfaces apply animate-dialog-in', () => {
    const hits = DIALOG_CANDIDATES.filter((rel) => read(rel).includes('animate-dialog-in'));
    expect(
      hits.length,
      `Expected >=4 of 6 dialog files to use animate-dialog-in. Found ${hits.length}: ${hits.join(', ')}`,
    ).toBeGreaterThanOrEqual(4);
  });

  it('at least 2 of 3 popover surfaces apply animate-popover-in', () => {
    const hits = POPOVER_CANDIDATES.filter((rel) => read(rel).includes('animate-popover-in'));
    expect(
      hits.length,
      `Expected >=2 of 3 popover files to use animate-popover-in. Found ${hits.length}: ${hits.join(', ')}`,
    ).toBeGreaterThanOrEqual(2);
  });

  it('ImportDialog and PinEditor overlays apply animate-overlay-in', () => {
    expect(read('components/ImportDialog.tsx')).toContain('animate-overlay-in');
    expect(read('components/PinEditor.tsx')).toContain('animate-overlay-in');
  });
});
