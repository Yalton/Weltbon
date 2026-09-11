/**
 * api/src/services/rename-term.ts
 *
 * Issue #59 — propagate a dictionary-term rename through the entry Markdown
 * that references it.
 *
 * The workflow this exists for: draft with placeholder nomenclature, keep the
 * glossary honest, then adopt final names across the corpus without hand-editing
 * every note. Renaming the `dictionary_words` row alone leaves every reference
 * pointing at a term that no longer exists.
 *
 * Two reference forms are rewritten, and they are not the same problem:
 *
 *   Wikilinks — `[[ayin]]`, `[[ayin|the pocket]]`, `[[ayin#gloss]]`. The
 *     renderer resolves these case-insensitively against the dictionary, so the
 *     match here is case-insensitive too, and only the target is rewritten; the
 *     display label is left byte-identical, matching the entry-rename rule
 *     (rewrite-wikilinks D-03). A label that happens to spell the old term is
 *     prose the author chose, not a reference.
 *
 *   Plain prose — a bare `ayin` in a sentence. Matched whole-term and
 *     CASE-SENSITIVELY. A case-insensitive prose rewrite cannot know whether
 *     `Ayin` opens a sentence, names a character, or is the term, and choosing
 *     wrong edits prose the user never reviewed. Case-differing occurrences are
 *     reported as skips instead, so they are visible rather than silent.
 *
 * Everything inside fenced code or an inline code span is untouched, via the
 * shared `codeRanges` helper — an author who wrote the old spelling into an
 * example wrote it deliberately.
 *
 * The planner is pure and returns whole rewritten bodies, so the preview the
 * user accepts is exactly what gets written.
 */

import {
  WIKILINK_RE,
  buildReplacement,
  codeRanges,
  isInRange,
  parseWikilink,
} from './rewrite-wikilinks.js';

export type TermRenameEntry = {
  id: string;
  title: string;
  body: string;
  /**
   * Whether this entry's dictionary scope contains the word being renamed.
   *
   * The renderer picks an entry's dictionary by the language entry that entry
   * links to (EntryDetail D-02): a language-scoped word only resolves inside
   * entries linked to its language, and a universe-scoped word only resolves
   * inside entries linked to no language at all. An out-of-scope occurrence is
   * therefore not a reference to this term — it is a different word that
   * happens to share a spelling — so it is reported, never rewritten.
   */
  inScope: boolean;
};

export type TermRenameSkip = {
  entryId: string;
  title: string;
  reason: 'out_of_scope' | 'case_mismatch';
  count: number;
};

export type TermRenamePlan = {
  entries: Array<{
    entryId: string;
    title: string;
    wikilinkCount: number;
    textCount: number;
    /** The entry body after the rewrite — what apply writes, byte for byte. */
    newBody: string;
  }>;
  skipped: TermRenameSkip[];
  /** Total replacements across every affected entry. */
  totalOccurrences: number;
};

/** Escape a term for literal use inside a RegExp. */
function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Characters that continue a term rather than bound it.
 *
 * Letters, digits and underscore are the usual set. Apostrophe and hyphen are
 * added because constructed languages use them inside words — without them a
 * term `k` would match the `k` in `k'tal`, and renaming it would corrupt an
 * unrelated word.
 */
const TERM_CHAR = "[\\p{L}\\p{N}_'\\-]";

/**
 * Build the whole-term matcher for `term`. Lookaround rather than `\b` because
 * `\b` is defined on ASCII word characters and gets the boundaries of a
 * non-Latin term wrong.
 */
function termPattern(term: string, caseInsensitive: boolean): RegExp {
  const flags = caseInsensitive ? 'gui' : 'gu';
  return new RegExp(`(?<!${TERM_CHAR})${escapeRegExp(term)}(?!${TERM_CHAR})`, flags);
}

/**
 * Plan the rewrite for one universe's entries.
 *
 * @param entries  Every entry considered, each flagged with whether the term is
 *                 in its dictionary scope.
 * @param oldWord  The current spelling.
 * @param newWord  The spelling to adopt.
 */
export function planTermRename(
  entries: TermRenameEntry[],
  oldWord: string,
  newWord: string,
): TermRenamePlan {
  const oldTrimmed = oldWord.trim();
  const newTrimmed = newWord.trim();
  const plan: TermRenamePlan = { entries: [], skipped: [], totalOccurrences: 0 };

  if (oldTrimmed.length === 0 || newTrimmed.length === 0) return plan;
  if (oldTrimmed === newTrimmed) return plan;

  const oldLower = oldTrimmed.toLowerCase();

  for (const entry of entries) {
    const found = rewriteBody(entry.body, oldTrimmed, oldLower, newTrimmed);

    if (!entry.inScope) {
      // Report, never rewrite. The count is what the user would be giving up.
      const total = found.wikilinkCount + found.textCount + found.caseMismatchCount;
      if (total > 0) {
        plan.skipped.push({
          entryId: entry.id,
          title: entry.title,
          reason: 'out_of_scope',
          count: total,
        });
      }
      continue;
    }

    if (found.caseMismatchCount > 0) {
      plan.skipped.push({
        entryId: entry.id,
        title: entry.title,
        reason: 'case_mismatch',
        count: found.caseMismatchCount,
      });
    }

    const changed = found.wikilinkCount + found.textCount;
    if (changed === 0) continue;

    plan.entries.push({
      entryId: entry.id,
      title: entry.title,
      wikilinkCount: found.wikilinkCount,
      textCount: found.textCount,
      newBody: found.body,
    });
    plan.totalOccurrences += changed;
  }

  return plan;
}

/**
 * Rewrite one body, collecting every replacement before splicing so that both
 * reference forms are decided against the ORIGINAL offsets. Rewriting wikilinks
 * first and prose second over the already-edited string would let a new term
 * containing the old one be rewritten twice.
 */
function rewriteBody(
  body: string,
  oldWord: string,
  oldLower: string,
  newWord: string,
): { body: string; wikilinkCount: number; textCount: number; caseMismatchCount: number } {
  const code = codeRanges(body);

  // --- Pass 1: wikilinks ---------------------------------------------------
  type Splice = { index: number; length: number; text: string };
  const splices: Splice[] = [];
  const linkRanges: Array<[number, number]> = [];
  let wikilinkCount = 0;

  WIKILINK_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = WIKILINK_RE.exec(body)) !== null) {
    const start = match.index;
    const end = start + match[0].length;
    // A wikilink is never plain prose, whether or not its target matches.
    linkRanges.push([start, end]);
    if (isInRange(start, code)) continue;

    const { target } = parseWikilink(match[1]);
    if (target.toLowerCase().trim() !== oldLower) continue;

    splices.push({
      index: start,
      length: match[0].length,
      text: buildReplacement(match[1], newWord),
    });
    wikilinkCount++;
  }

  // --- Pass 2: prose -------------------------------------------------------
  let textCount = 0;
  const exact = termPattern(oldWord, false);
  let m: RegExpExecArray | null;
  while ((m = exact.exec(body)) !== null) {
    if (isInRange(m.index, code) || isInRange(m.index, linkRanges)) continue;
    splices.push({ index: m.index, length: m[0].length, text: newWord });
    textCount++;
  }

  // Case-differing prose occurrences: counted, never rewritten.
  let caseMismatchCount = 0;
  const loose = termPattern(oldWord, true);
  while ((m = loose.exec(body)) !== null) {
    if (m[0] === oldWord) continue;
    if (isInRange(m.index, code) || isInRange(m.index, linkRanges)) continue;
    caseMismatchCount++;
  }

  if (splices.length === 0) {
    return { body, wikilinkCount, textCount, caseMismatchCount };
  }

  // Right-to-left so earlier offsets stay valid.
  splices.sort((a, b) => b.index - a.index);
  let result = body;
  for (const s of splices) {
    result = result.slice(0, s.index) + s.text + result.slice(s.index + s.length);
  }

  return { body: result, wikilinkCount, textCount, caseMismatchCount };
}
