import { useMemo, useState } from 'react';
import type { Entry } from '../hooks/useEntries';
import { useUpdateEntry } from '../hooks/useEntries';
import { isInsideCodeSpan } from './WikilinkAutocomplete';

// Reuse WikilinkText's WIKILINK_RE pattern to locate existing [[ ]] spans so
// occurrences that are already linked are NOT surfaced as unlinked mentions.
// Group 2 is the inner ref (group 1 = optional leading `!` for embeds).
const WIKILINK_RE = /(!?)\[\[([^\]\n]+?)\]\]/g;

interface Mention {
  /** The source entry that contains the mention. */
  sourceEntryId: string;
  sourceTitle: string;
  /** Character index of the matched text in the source body. */
  matchIndex: number;
  matchLength: number;
  /** The exact prose text that matched (may differ in case from canonical title). */
  matchedText: string;
  /** Short context window around the match for display. */
  snippet: string;
}

interface Props {
  universeId: string;
  /** The entry being viewed — its title + aliases are the scan targets. */
  entry: Entry;
  /** Full corpus: all universe entries with their bodies (from useEntries cache). */
  allEntries: Entry[];
  /** Called after a successful linkify so EntryDetail can refetch. */
  onLinked?: () => void;
}

/**
 * Scan the cached entry corpus for prose that mentions `entry` (by title or
 * alias) without a [[ ]] link, and let the author linkify a single occurrence
 * with one click (XREF-06, D-11..D-15).
 *
 * Whole-word (D-13): uses \b-bounded regex, so "Sun" does NOT fire on "Sunday".
 * Case-insensitive (D-13): "empire" matches entry title "Empire".
 * Min-length floor (D-13): names shorter than 3 chars are excluded to prevent noise.
 * Skip inside [[ ]]: occurrences already in a wikilink span are excluded.
 * Skip inside code (D-13): uses isInsideCodeSpan from WikilinkAutocomplete.
 * Linkify form (D-14): bare [[Title]] when text matches title exactly, else
 *   [[Title|matchedText]] so the sentence still reads as written.
 * Single-occurrence linkify (D-15): only the selected occurrence is rewritten.
 *
 * Does NOT introduce any new query key — corpus is the passed allEntries prop
 * (memory: react-query-key-change-blast-radius).
 */
export function UnlinkedMentionsPanel({ universeId, entry, allEntries, onLinked }: Props) {
  const [pendingId, setPendingId] = useState<string | null>(null);

  // Compute the list of unlinked mentions across all other entries.
  const mentions = useMemo<Mention[]>(() => {
    // D-13 min-length floor = 3
    const targets = [entry.title, ...(entry.aliases ?? [])].filter(
      (name) => name.trim().length >= 3,
    );
    if (targets.length === 0) return [];

    // Build a whole-word, case-insensitive alternation regex (D-13).
    const escaped = targets.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    const pattern = new RegExp(`\\b(${escaped.join('|')})\\b`, 'gi');

    const result: Mention[] = [];

    for (const sourceEntry of allEntries) {
      // Exclude the entry being viewed from its own corpus scan (D-11).
      if (sourceEntry.id === entry.id) continue;

      const body: string = (sourceEntry as { body?: string }).body ?? '';
      if (!body) continue;

      // Build protected ranges: character spans already inside [[ ]] links.
      // These occurrences are already linked and must be skipped (D-13).
      const linkedRanges: Array<[number, number]> = [];
      WIKILINK_RE.lastIndex = 0;
      let wikilinkMatch: RegExpExecArray | null;
      while ((wikilinkMatch = WIKILINK_RE.exec(body)) !== null) {
        linkedRanges.push([wikilinkMatch.index, wikilinkMatch.index + wikilinkMatch[0].length]);
      }

      // Scan for whole-word prose matches.
      pattern.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(body)) !== null) {
        const idx = match.index;
        const len = match[0].length;

        // Skip if this match falls inside an existing [[ ]] span (D-13).
        const insideLink = linkedRanges.some(([start, end]) => idx >= start && idx + len <= end);
        if (insideLink) continue;

        // Skip if this match is inside a code span (D-13 / Phase 47 D-11).
        if (isInsideCodeSpan(body, idx)) continue;

        // Build a short context snippet around the match (~80 chars).
        const snippetStart = Math.max(0, idx - 40);
        const snippetEnd = Math.min(body.length, idx + len + 40);
        let snippet = body.slice(snippetStart, snippetEnd).trim();
        if (snippetStart > 0) snippet = '…' + snippet;
        if (snippetEnd < body.length) snippet = snippet + '…';

        result.push({
          sourceEntryId: sourceEntry.id,
          sourceTitle: sourceEntry.title,
          matchIndex: idx,
          matchLength: len,
          matchedText: match[0],
          snippet,
        });
      }
    }

    return result;
  }, [allEntries, entry]);

  // Per-mention linkify handler (D-15 single occurrence, D-14 bare vs piped form).
  const handleLinkify = (mention: Mention) => {
    const sourceEntry = allEntries.find((e) => e.id === mention.sourceEntryId);
    if (!sourceEntry) return;

    const body: string = (sourceEntry as { body?: string }).body ?? '';

    // D-14: bare [[Title]] when matched text equals canonical title exactly;
    // otherwise [[Title|matchedText]] to preserve how the prose reads.
    const canonical = entry.title;
    const replacement =
      mention.matchedText === canonical
        ? `[[${canonical}]]`
        : `[[${canonical}|${mention.matchedText}]]`;

    // D-15: splice only this single occurrence at [matchIndex, matchIndex+matchLength).
    const newBody =
      body.slice(0, mention.matchIndex) +
      replacement +
      body.slice(mention.matchIndex + mention.matchLength);

    setPendingId(`${mention.sourceEntryId}:${mention.matchIndex}`);

    // Note: useUpdateEntry is called per-mention; instantiated here via a
    // closure. Because React hooks can't be called conditionally we initialise
    // the mutation inline and trigger it immediately.
    // eslint-disable-next-line react-hooks/rules-of-hooks -- not conditional; the
    // closure only captures the hook result from the component scope.
    // The mutation is triggered directly; the hook instance below is created in
    // render time (satisfies Rules of Hooks) and we just call .mutate here.
    // See LinkifyButton sub-component below — this is where the per-mention
    // mutation is actually wired so hooks are never called inside a callback.
  };

  return (
    <div className="mt-6 pt-6 border-t border-neutral-200 dark:border-neutral-800">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-semibold">Unlinked mentions ({mentions.length})</h2>
      </div>
      {mentions.length === 0 ? (
        <p className="mt-2 text-sm text-neutral-500">No unlinked mentions found.</p>
      ) : (
        <ul className="mt-3 space-y-2">
          {mentions.map((m) => {
            const mentionKey = `${m.sourceEntryId}:${m.matchIndex}`;
            return (
              <li
                key={mentionKey}
                className="flex items-start justify-between gap-3 rounded-md border border-neutral-200 dark:border-neutral-800 px-3 py-2"
              >
                <div className="min-w-0 flex-1">
                  <p className="text-xs text-neutral-400 mb-0.5 font-medium truncate">
                    {m.sourceTitle}
                  </p>
                  <p className="text-sm text-neutral-300 break-words">
                    {m.snippet}
                  </p>
                </div>
                <LinkifyButton
                  universeId={universeId}
                  mention={m}
                  allEntries={allEntries}
                  canonicalTitle={entry.title}
                  isPending={pendingId === mentionKey}
                  onPending={() => setPendingId(mentionKey)}
                  onLinked={() => {
                    setPendingId(null);
                    onLinked?.();
                  }}
                />
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/**
 * Sub-component that owns one useUpdateEntry hook instance per mention row.
 * This satisfies the Rules of Hooks (hook called unconditionally in render,
 * not inside an event handler).
 */
function LinkifyButton({
  universeId,
  mention,
  allEntries,
  canonicalTitle,
  isPending,
  onPending,
  onLinked,
}: {
  universeId: string;
  mention: Mention;
  allEntries: Entry[];
  canonicalTitle: string;
  isPending: boolean;
  onPending: () => void;
  onLinked: () => void;
}) {
  const updateEntry = useUpdateEntry(universeId, mention.sourceEntryId);

  const handleClick = () => {
    const sourceEntry = allEntries.find((e) => e.id === mention.sourceEntryId);
    if (!sourceEntry) return;

    const body: string = (sourceEntry as { body?: string }).body ?? '';

    // D-14: bare [[Title]] when matched text equals canonical title exactly.
    const replacement =
      mention.matchedText === canonicalTitle
        ? `[[${canonicalTitle}]]`
        : `[[${canonicalTitle}|${mention.matchedText}]]`;

    // D-15: splice only this single occurrence.
    const newBody =
      body.slice(0, mention.matchIndex) +
      replacement +
      body.slice(mention.matchIndex + mention.matchLength);

    onPending();
    updateEntry.mutate({ body: newBody }, { onSuccess: () => onLinked() });
  };

  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={isPending || updateEntry.isPending}
      className="shrink-0 rounded-md border border-neutral-300 dark:border-neutral-700 text-sm px-3 py-1.5 hover:bg-neutral-50 dark:hover:bg-neutral-800 disabled:opacity-50"
    >
      {isPending || updateEntry.isPending ? 'Linking…' : 'Link'}
    </button>
  );
}
