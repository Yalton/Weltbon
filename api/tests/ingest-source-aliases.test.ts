/**
 * Tests for planSourceAliases in api/src/services/ingest-commit.ts (#60).
 *
 * Resolving filename links during *preview* only fixes the batch being
 * imported. The rendered entry resolves `[[ayin_pockets]]` through
 * WikilinkText's title → alias → dictionary ladder, so unless the commit
 * records the source path as an alias the link still falls through to the
 * dictionary "missing term" flow after import.
 */

import { describe, it, expect } from 'vitest';
import { planSourceAliases } from '../src/services/ingest-commit.js';

describe('planSourceAliases (#60)', () => {
  it('stores the path form and the basename form', () => {
    const plan = planSourceAliases(
      [{ path: 'lore/ayin_pockets.md', title: 'Ayin Pockets' }],
      [],
    );
    expect(plan).toEqual([['lore/ayin_pockets', 'ayin_pockets']]);
  });

  it('stores one form for a file at the batch root', () => {
    const plan = planSourceAliases([{ path: 'ayin_pockets.md', title: 'Ayin Pockets' }], []);
    expect(plan).toEqual([['ayin_pockets']]);
  });

  it('preserves the case the vault used', () => {
    const plan = planSourceAliases([{ path: 'Lore/Ayin_Pockets.md', title: 'Ayin Pockets' }], []);
    expect(plan).toEqual([['Lore/Ayin_Pockets', 'Ayin_Pockets']]);
  });

  it('drops an alias equal to the entry’s own title', () => {
    // The title tier already resolves this; storing it duplicates the entry
    // name in the UI for no gain.
    const plan = planSourceAliases([{ path: 'notes/Glossary.md', title: 'Glossary' }], []);
    expect(plan).toEqual([['notes/Glossary']]);
  });

  it('drops a basename that two accepted files share', () => {
    const plan = planSourceAliases(
      [
        { path: 'a/notes.md', title: 'A Notes' },
        { path: 'b/notes.md', title: 'B Notes' },
      ],
      [],
    );
    expect(plan).toEqual([['a/notes'], ['b/notes']]);
  });

  it('drops an alias that collides with another entry’s title', () => {
    // An alias can never outrank a title in either resolver, so this one would
    // be dead weight that also misreports which entry owns the name.
    const plan = planSourceAliases(
      [
        { path: 'lore/beta.md', title: 'Ayin Pockets' },
        { path: 'lore/other.md', title: 'Beta' },
      ],
      [],
    );
    expect(plan).toEqual([['lore/beta'], ['lore/other', 'other']]);
  });

  it('drops an alias that collides with an existing universe title', () => {
    const plan = planSourceAliases([{ path: 'lore/beta.md', title: 'New Note' }], ['Beta']);
    expect(plan).toEqual([['lore/beta']]);
  });

  it('drops an alias longer than the 100-char per-alias cap', () => {
    const long = 'x'.repeat(101);
    const plan = planSourceAliases([{ path: `${long}.md`, title: 'Long' }], []);
    expect(plan).toEqual([[]]);
  });
});
