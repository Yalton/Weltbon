/**
 * Tests for planTermRename (#59).
 *
 * The planner decides what a dictionary-term rename does to entry prose. Its
 * failure mode is not a crash — it is a body quietly rewritten somewhere the
 * user did not look, so most of these tests are about what it REFUSES to touch.
 */

import { describe, it, expect } from 'vitest';
import { planTermRename, type TermRenameEntry } from '../src/services/rename-term.js';

function entry(over: Partial<TermRenameEntry> & { id: string; body: string }): TermRenameEntry {
  return { title: over.id, inScope: true, ...over };
}

function plan(entries: TermRenameEntry[], from = 'ayin', to = 'vaelin') {
  return planTermRename(entries, from, to);
}

describe('planTermRename (#59) — wikilinks', () => {
  it('rewrites a bare wikilink target', () => {
    const result = plan([entry({ id: 'a', body: 'The [[ayin]] is deep.' })]);
    expect(result.entries[0].newBody).toBe('The [[vaelin]] is deep.');
    expect(result.entries[0].wikilinkCount).toBe(1);
    expect(result.entries[0].textCount).toBe(0);
  });

  it('rewrites the target of an aliased wikilink and leaves the label alone', () => {
    const result = plan([entry({ id: 'a', body: 'The [[ayin|ayin pocket]] is deep.' })]);
    expect(result.entries[0].newBody).toBe('The [[vaelin|ayin pocket]] is deep.');
  });

  it('preserves a heading anchor', () => {
    const result = plan([entry({ id: 'a', body: 'See [[ayin#gloss]].' })]);
    expect(result.entries[0].newBody).toBe('See [[vaelin#gloss]].');
  });

  it('matches a wikilink target case-insensitively, as the renderer does', () => {
    const result = plan([entry({ id: 'a', body: 'See [[Ayin]].' })]);
    expect(result.entries[0].newBody).toBe('See [[vaelin]].');
  });
});

describe('planTermRename (#59) — prose', () => {
  it('rewrites a whole-word prose occurrence', () => {
    const result = plan([entry({ id: 'a', body: 'An ayin opened.' })]);
    expect(result.entries[0].newBody).toBe('An vaelin opened.');
    expect(result.entries[0].textCount).toBe(1);
  });

  it('never rewrites a substring of a longer word', () => {
    const result = plan([entry({ id: 'a', body: 'The ayinborn and ayin-touched and Mayin.' })]);
    expect(result.entries).toEqual([]);
  });

  it('treats an apostrophe as part of the term, not a boundary', () => {
    // A conlang term like k'tal must not be split by a rename of `k`.
    const result = planTermRename([entry({ id: 'a', body: "The k'tal sang." })], 'k', 'q');
    expect(result.entries).toEqual([]);
  });

  it('reports a case-differing occurrence instead of rewriting it', () => {
    // "Ayin" may be a sentence opener, a name, or the term. The planner cannot
    // tell, so it says so rather than choosing.
    const result = plan([entry({ id: 'a', body: 'Ayin is a kind of ayin.' })]);
    expect(result.entries[0].newBody).toBe('Ayin is a kind of vaelin.');
    expect(result.skipped).toEqual([
      { entryId: 'a', title: 'a', reason: 'case_mismatch', count: 1 },
    ]);
  });

  it('counts a prose occurrence separately from a wikilink one', () => {
    const result = plan([entry({ id: 'a', body: 'An ayin. See [[ayin]].' })]);
    expect(result.entries[0]).toMatchObject({ wikilinkCount: 1, textCount: 1 });
    expect(result.entries[0].newBody).toBe('An vaelin. See [[vaelin]].');
    expect(result.totalOccurrences).toBe(2);
  });

  it('does not rewrite prose inside a wikilink label', () => {
    // The label is prose the author wrote for this link; only the target is a
    // reference to the term.
    const result = plan([entry({ id: 'a', body: 'See [[somewhere|an ayin]].' })]);
    expect(result.entries).toEqual([]);
  });
});

describe('planTermRename (#59) — code', () => {
  it('leaves a fenced code block untouched', () => {
    const body = 'Text.\n\n```\nayin\n[[ayin]]\n```\n';
    const result = plan([entry({ id: 'a', body })]);
    expect(result.entries).toEqual([]);
  });

  it('leaves an inline code span untouched', () => {
    const result = plan([entry({ id: 'a', body: 'The term `ayin` is spelled thus.' })]);
    expect(result.entries).toEqual([]);
  });
});

describe('planTermRename (#59) — scope', () => {
  it('reports an out-of-scope entry without rewriting it', () => {
    const result = plan([
      entry({ id: 'in', title: 'In', body: 'An ayin.' }),
      entry({ id: 'out', title: 'Out', body: 'An ayin and [[ayin]].', inScope: false }),
    ]);

    expect(result.entries.map((e) => e.entryId)).toEqual(['in']);
    expect(result.skipped).toEqual([
      { entryId: 'out', title: 'Out', reason: 'out_of_scope', count: 2 },
    ]);
  });

  it('says nothing about an out-of-scope entry with no occurrences', () => {
    const result = plan([entry({ id: 'out', body: 'Unrelated prose.', inScope: false })]);
    expect(result.skipped).toEqual([]);
  });
});

describe('planTermRename (#59) — no-ops', () => {
  it('plans nothing when the spelling is unchanged', () => {
    const result = planTermRename([entry({ id: 'a', body: 'An ayin.' })], 'ayin', 'ayin');
    expect(result).toEqual({ entries: [], skipped: [], totalOccurrences: 0 });
  });

  it('plans nothing for an empty new spelling', () => {
    const result = planTermRename([entry({ id: 'a', body: 'An ayin.' })], 'ayin', '   ');
    expect(result.entries).toEqual([]);
  });

  it('omits an entry with no occurrences', () => {
    const result = plan([entry({ id: 'a', body: 'Nothing here.' })]);
    expect(result.entries).toEqual([]);
    expect(result.totalOccurrences).toBe(0);
  });

  it('rewrites a term that contains the new one without double-applying', () => {
    // `ayin` -> `ayinx` must not then match `ayinx` and run again.
    const result = planTermRename([entry({ id: 'a', body: 'An ayin and [[ayin]].' })], 'ayin', 'ayinx');
    expect(result.entries[0].newBody).toBe('An ayinx and [[ayinx]].');
  });
});
