/**
 * api/src/services/repair-wikilinks.ts
 *
 * Issue #60 — backfill for universes imported before filename/path wikilinks
 * resolved.
 *
 * The importer now records each note's source path as an entry alias, so
 * `[[lore/ayin_pockets]]` keeps working after import. Universes imported before
 * that have neither the alias nor any record of the source path: the only
 * surviving trace of the original filename is the title the importer derived
 * from the note's H1. AyinsEdge is the case that motivated this — 35 notes,
 * 232 refs reported unresolved, 11 link rows written.
 *
 * So the repair reconstructs filenames from titles, and only ever in the
 * direction the evidence supports:
 *
 *   - It mints an alias ONLY for a ref that some entry body actually contains
 *     and that currently resolves to nothing. It never enumerates plausible
 *     aliases for every entry; an alias nobody links to is noise in the UI and
 *     a future collision.
 *   - It mints an alias only when EXACTLY ONE entry's title could have produced
 *     the ref. Two candidates means the guess could wire prose to the wrong
 *     entry, and that is not something the reader is going to audit.
 *   - It never mints an alias that any title already answers: the title tier
 *     outranks the alias tier in both resolvers, so such an alias is
 *     unreachable and merely mislabels its owner.
 *
 * It also writes the `links` rows the original import skipped. Ingest only
 * created a row for refs it resolved at the time, so a title-resolvable ref
 * renders as a link today while being absent from the graph.
 *
 * The planner is pure so the route can offer a dry run that is, byte for byte,
 * what apply would do.
 */

import { scanWikilinks, normalizeLinkTarget } from './ingest-markdown.js';

export type RepairEntry = {
  id: string;
  title: string;
  aliases: string[];
  body: string;
};

export type RepairPlan = {
  /** One record per entry that gains aliases, in entry order. */
  aliasAdditions: Array<{ entryId: string; aliases: string[] }>;
  /** Link rows to insert, deduped against existing rows and each other. */
  linkAdditions: Array<{ sourceEntryId: string; targetEntryId: string; label: string }>;
  /** Refs left alone, with the reason, so the caller can show its work. */
  unresolved: Array<{ entryId: string; target: string; reason: 'ambiguous' | 'no_match' }>;
};

/**
 * The filename forms a title could plausibly have had in an Obsidian vault.
 *
 * Obsidian's "new note from link" writes the link text verbatim as the
 * filename and vault authors rename by hand; the three forms below are what
 * that produces in practice — `Ayin Pockets` stored as `ayin_pockets`,
 * `ayin-pockets`, or `ayinpockets`. Punctuation is dropped because a filename
 * cannot always carry it.
 *
 * Deliberately NOT included: fuzzy or partial matching. Every form here is a
 * total transform of the whole title. A prefix or edit-distance match would let
 * "Ayin" capture links meant for "Ayin Pockets".
 */
export function titleSlugForms(title: string): string[] {
  const lower = title.toLowerCase().trim();
  // Strip anything that is not a letter, number, space, underscore or hyphen —
  // `AYIN POCKETS!` and `Ayin Pockets` must collapse to the same candidate so
  // that the ambiguity is detected rather than silently resolved one way.
  const cleaned = lower.replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/\s+/g, ' ').trim();
  if (cleaned.length === 0) return [];
  return [...new Set([
    cleaned.replace(/ /g, '_'),
    cleaned.replace(/ /g, '-'),
    cleaned.replace(/ /g, ''),
  ])];
}

/**
 * Plan the alias and link backfill for one universe.
 *
 * @param entries        Every entry in the universe (id, title, aliases, body).
 * @param existingLinks  Existing link rows, so nothing is inserted twice.
 */
export function planWikilinkRepair(
  entries: RepairEntry[],
  existingLinks: Array<{ sourceEntryId: string; targetEntryId: string }>,
): RepairPlan {
  // --- Current resolution state, mirroring WikilinkText's ladder -------------
  const byTitle = new Map<string, string>();
  for (const e of entries) {
    const key = e.title.trim().toLowerCase();
    if (!byTitle.has(key)) byTitle.set(key, e.id);
  }
  const byAlias = new Map<string, string>();
  for (const e of entries) {
    for (const alias of e.aliases ?? []) {
      const key = normalizeLinkTarget(alias.trim());
      if (key.length === 0 || byTitle.has(key)) continue;
      if (!byAlias.has(key)) byAlias.set(key, e.id);
    }
  }

  // --- Candidate owners by slug --------------------------------------------
  // slug -> entry ids that could have produced it. More than one id means the
  // slug is ambiguous and no alias is minted for it.
  const bySlug = new Map<string, string[]>();
  for (const e of entries) {
    for (const slug of titleSlugForms(e.title)) {
      const owners = bySlug.get(slug);
      if (owners) {
        if (!owners.includes(e.id)) owners.push(e.id);
      } else {
        bySlug.set(slug, [e.id]);
      }
    }
  }

  const newAliases = new Map<string, string[]>();     // entryId -> aliases to add
  const mintedFor = new Map<string, string>();        // ref key -> entryId
  const linkAdditions: RepairPlan['linkAdditions'] = [];
  const unresolved: RepairPlan['unresolved'] = [];

  const linkSeen = new Set<string>(
    existingLinks.map((l) => `${l.sourceEntryId} ${l.targetEntryId}`),
  );

  for (const source of entries) {
    for (const ref of scanWikilinks(source.body)) {
      const key = normalizeLinkTarget(ref.target);
      if (key.length === 0) continue;

      // Tier 1/2: already resolvable, or resolvable because of an alias minted
      // earlier in this same pass.
      let targetId = byTitle.get(key) ?? byAlias.get(key) ?? mintedFor.get(key);

      if (!targetId) {
        // Tier 3: reconstruct. Match the whole ref first, then its final path
        // segment — `[[lore/ayin_pockets]]` names the file `ayin_pockets`.
        const segment = key.includes('/') ? key.slice(key.lastIndexOf('/') + 1) : key;
        const owners = bySlug.get(key) ?? bySlug.get(segment);

        if (!owners) {
          unresolved.push({ entryId: source.id, target: ref.target, reason: 'no_match' });
          continue;
        }
        if (owners.length > 1) {
          unresolved.push({ entryId: source.id, target: ref.target, reason: 'ambiguous' });
          continue;
        }

        targetId = owners[0];
        // Store the ref exactly as the bodies write it, so the alias answers
        // the link that exists rather than a normalized form of it.
        const list = newAliases.get(targetId);
        if (list) list.push(key);
        else newAliases.set(targetId, [key]);
        mintedFor.set(key, targetId);
      }

      // A ref to the entry's own body renders fine but must not become a
      // self-edge in the graph.
      if (targetId === source.id) continue;

      const pairKey = `${source.id} ${targetId}`;
      if (linkSeen.has(pairKey)) continue;
      linkSeen.add(pairKey);
      linkAdditions.push({
        sourceEntryId: source.id,
        targetEntryId: targetId,
        label: ref.label,
      });
    }
  }

  // Emit alias additions in entry order for a stable, reviewable plan.
  const aliasAdditions: RepairPlan['aliasAdditions'] = [];
  for (const e of entries) {
    const added = newAliases.get(e.id);
    if (added && added.length > 0) {
      aliasAdditions.push({ entryId: e.id, aliases: added });
    }
  }

  return { aliasAdditions, linkAdditions, unresolved };
}
