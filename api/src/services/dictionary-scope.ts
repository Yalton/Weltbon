/**
 * api/src/services/dictionary-scope.ts
 *
 * Issue #59 — which dictionary an entry's `[[term]]` resolves against.
 *
 * This is not a new rule. `EntryDetail` (D-02) picks an entry's dictionary by
 * walking that entry's outbound links for a `language`-type entry: found means
 * the language-scoped dictionary, not found means the universe-wide union. A
 * rename that rewrites prose has to agree with the renderer exactly, or it
 * edits text that never resolved to the renamed term in the first place.
 *
 * Kept server-side and separate from the route so the rule has one home rather
 * than a copy inside whichever handler needed it next.
 */

export type ScopeLink = { sourceEntryId: string; targetEntryId: string };
export type ScopeEntry = { id: string; entryType: string };

/**
 * Map every entry to the id of the language entry it links to, or null when it
 * links to none.
 *
 * When an entry links more than one language entry the first by link order
 * wins, matching EntryDetail's loop. That is arbitrary, but it is the same
 * arbitrary choice the reader already sees on the page.
 */
export function resolveEntryLanguages(
  entries: ScopeEntry[],
  links: ScopeLink[],
): Map<string, string | null> {
  const languageIds = new Set(
    entries.filter((e) => e.entryType === 'language').map((e) => e.id),
  );

  const result = new Map<string, string | null>();
  for (const entry of entries) result.set(entry.id, null);

  for (const link of links) {
    if (!result.has(link.sourceEntryId)) continue;
    if (result.get(link.sourceEntryId) !== null) continue; // first link wins
    if (languageIds.has(link.targetEntryId)) {
      result.set(link.sourceEntryId, link.targetEntryId);
    }
  }

  return result;
}

/**
 * Whether a word scoped to `wordLanguageEntryId` resolves inside an entry whose
 * linked language is `entryLanguageEntryId`.
 *
 * A universe-level word (null scope) is only reachable from entries that link
 * no language — an entry linked to a language sees that language's dictionary
 * alone, so the universe-level spelling is not the term it references.
 */
export function wordIsInScope(
  wordLanguageEntryId: string | null,
  entryLanguageEntryId: string | null,
): boolean {
  return wordLanguageEntryId === entryLanguageEntryId;
}
