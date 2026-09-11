/**
 * Tests for planWikilinkRepair (#60).
 *
 * Fixing the importer only helps the next import. A universe imported before
 * the fix — AyinsEdge, 35 notes and 232 unresolved refs — has entries whose
 * bodies still say `[[ayin_pockets]]` and whose source paths were never
 * recorded. The repair planner reconstructs the mapping from the one thing
 * that survived: the titles the importer derived from each note's H1.
 *
 * The planner is pure; the route applies what it returns.
 */

import { describe, it, expect } from 'vitest';
import { planWikilinkRepair, type RepairEntry } from '../src/services/repair-wikilinks.js';

function entry(over: Partial<RepairEntry> & { id: string; title: string }): RepairEntry {
  return { aliases: [], body: '', ...over };
}

describe('planWikilinkRepair (#60)', () => {
  it('mints an underscore-slug alias when exactly one title matches', () => {
    const plan = planWikilinkRepair(
      [
        entry({ id: 'a', title: 'Index', body: 'See [[ayin_pockets|Ayin pocket]].' }),
        entry({ id: 'b', title: 'Ayin Pockets' }),
      ],
      [],
    );

    expect(plan.aliasAdditions).toEqual([{ entryId: 'b', aliases: ['ayin_pockets'] }]);
    expect(plan.linkAdditions).toEqual([
      { sourceEntryId: 'a', targetEntryId: 'b', label: 'Ayin pocket' },
    ]);
    expect(plan.unresolved).toEqual([]);
  });

  it('matches a hyphen slug and a space-stripped slug', () => {
    const plan = planWikilinkRepair(
      [
        entry({ id: 'a', title: 'Index', body: '[[ayin-pockets]] and [[ayinpockets]]' }),
        entry({ id: 'b', title: 'Ayin Pockets' }),
      ],
      [],
    );

    expect(plan.aliasAdditions).toEqual([
      { entryId: 'b', aliases: ['ayin-pockets', 'ayinpockets'] },
    ]);
    expect(plan.linkAdditions).toHaveLength(1); // one link row per entry pair
  });

  it('matches a folder path by its final segment', () => {
    const plan = planWikilinkRepair(
      [
        entry({ id: 'a', title: 'Index', body: 'See [[lore/ayin_pockets]].' }),
        entry({ id: 'b', title: 'Ayin Pockets' }),
      ],
      [],
    );

    // The alias stored is the full ref, so the exact link in the body resolves.
    expect(plan.aliasAdditions).toEqual([{ entryId: 'b', aliases: ['lore/ayin_pockets'] }]);
  });

  it('refuses to guess when two titles produce the same slug', () => {
    const plan = planWikilinkRepair(
      [
        entry({ id: 'a', title: 'Index', body: 'See [[ayin_pockets]].' }),
        entry({ id: 'b', title: 'Ayin Pockets' }),
        entry({ id: 'c', title: 'AYIN POCKETS!' }),
      ],
      [],
    );

    expect(plan.aliasAdditions).toEqual([]);
    expect(plan.unresolved).toEqual([
      { entryId: 'a', target: 'ayin_pockets', reason: 'ambiguous' },
    ]);
  });

  it('leaves a ref with no candidate alone', () => {
    const plan = planWikilinkRepair(
      [entry({ id: 'a', title: 'Index', body: 'See [[never_written]].' })],
      [],
    );

    expect(plan.aliasAdditions).toEqual([]);
    expect(plan.linkAdditions).toEqual([]);
    expect(plan.unresolved).toEqual([{ entryId: 'a', target: 'never_written', reason: 'no_match' }]);
  });

  it('creates the missing link row for a ref that already resolves by title', () => {
    // The renderer resolves this today; the graph does not, because ingest only
    // wrote link rows for refs it resolved at import time.
    const plan = planWikilinkRepair(
      [
        entry({ id: 'a', title: 'Index', body: 'See [[Ayin Pockets]].' }),
        entry({ id: 'b', title: 'Ayin Pockets' }),
      ],
      [],
    );

    expect(plan.aliasAdditions).toEqual([]);
    expect(plan.linkAdditions).toEqual([
      { sourceEntryId: 'a', targetEntryId: 'b', label: 'Ayin Pockets' },
    ]);
  });

  it('does not duplicate a link row that already exists', () => {
    const plan = planWikilinkRepair(
      [
        entry({ id: 'a', title: 'Index', body: 'See [[Ayin Pockets]].' }),
        entry({ id: 'b', title: 'Ayin Pockets' }),
      ],
      [{ sourceEntryId: 'a', targetEntryId: 'b' }],
    );

    expect(plan.linkAdditions).toEqual([]);
  });

  it('never mints an alias that shadows an existing title', () => {
    const plan = planWikilinkRepair(
      [
        entry({ id: 'a', title: 'Index', body: 'See [[notes]].' }),
        entry({ id: 'b', title: 'Notes' }),
        entry({ id: 'c', title: 'No Tes' }),
      ],
      [],
    );

    // [[notes]] already resolves to b by title; c's slug must not compete.
    expect(plan.aliasAdditions).toEqual([]);
    expect(plan.linkAdditions).toEqual([
      { sourceEntryId: 'a', targetEntryId: 'b', label: 'notes' },
    ]);
  });

  it('skips a self-reference', () => {
    const plan = planWikilinkRepair(
      [entry({ id: 'a', title: 'Ayin Pockets', body: 'See [[ayin_pockets]].' })],
      [],
    );

    // The alias is still worth storing — the ref renders as a link to itself —
    // but no self-edge is added to the graph.
    expect(plan.aliasAdditions).toEqual([{ entryId: 'a', aliases: ['ayin_pockets'] }]);
    expect(plan.linkAdditions).toEqual([]);
  });

  it('ignores refs inside fenced code', () => {
    const plan = planWikilinkRepair(
      [
        entry({ id: 'a', title: 'Index', body: '```\n[[ayin_pockets]]\n```\n' }),
        entry({ id: 'b', title: 'Ayin Pockets' }),
      ],
      [],
    );

    expect(plan.aliasAdditions).toEqual([]);
    expect(plan.linkAdditions).toEqual([]);
  });
});
