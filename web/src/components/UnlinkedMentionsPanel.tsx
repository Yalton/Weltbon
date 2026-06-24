import { useEffect, useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { Entry } from '../hooks/useEntries';
import { fetchEntryDetail, useUpdateEntry } from '../hooks/useEntries';
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
  /** Full corpus: all universe entries from useEntries cache (list rows — body is NOT projected). */
  allEntries: Entry[];
  /** Called after a successful linkify so EntryDetail can refetch. */
  onLinked?: () => void;
}

/**
 * Scan sibling entry bodies (fetched from the detail endpoint) for prose that
 * mentions `entry` (by title or alias) without a [[ ]] link, and let the
 * author linkify a single occurrence with one click (XREF-06, D-11..D-15).
 *
 * Body sourcing: the useEntries LIST cache never projects `body` (locked by
 * api/tests/entries.test.ts ENT-03). This panel fetches each sibling's body
 * from the detail endpoint (GET /universes/:uid/entries/:id) via
 * queryClient.fetchQuery on the existing ['entry', universeId, entryId] key.
 *
 * Whole-word (D-13): uses \b-bounded regex, so "Sun" does NOT fire on "Sunday".
 * Case-insensitive (D-13): "empire" matches entry title "Empire".
 * Min-length floor (D-13): names shorter than 3 chars are excluded to prevent noise.
 * Skip inside [[ ]]: occurrences already in a wikilink span are excluded.
 * Skip inside code (D-13): uses isInsideCodeSpan from WikilinkAutocomplete.
 * Linkify form (D-14): bare [[Title]] when text matches title exactly, else
 *   [[Title|matchedText]] so the sentence still reads as written.
 * Single-occurrence linkify (D-15): only the selected occurrence is rewritten.
 * Splice guard: if body.slice(matchIndex, matchIndex+matchLength) !== matchedText
 *   (stale index after a concurrent edit), the click aborts rather than corrupting.
 *
 * Does NOT introduce any new shared query key — reuses the existing
 * ['entry', universeId, entryId] key (memory: react-query-key-change-blast-radius).
 * isInsideCodeSpan backtick-count hardening deferred (WARNING — out of scope for
 * this data-integrity gap; remark-parse parity is a separate concern).
 */
export function UnlinkedMentionsPanel({ universeId, entry, allEntries, onLinked }: Props) {
  const [pendingId, setPendingId] = useState<string | null>(null);
  const queryClient = useQueryClient();

  // Map from sibling entry id → fetched body string.
  // Populated by the effect below; keyed so re-fetching one entry is cheap.
  const [siblingBodies, setSiblingBodies] = useState<Record<string, string>>({});

  // Fetch detail bodies for all non-self siblings whenever allEntries changes.
  // Uses the existing ['entry', universeId, entryId] cache key so the fetch
  // hits the cache if the entry was already loaded (e.g. user just visited it).
  useEffect(() => {
    let cancelled = false;
    const siblings = allEntries.filter((e) => e.id !== entry.id);

    void (async () => {
      const pairs = await Promise.all(
        siblings.map(async (sibling) => {
          try {
            const detail = await queryClient.fetchQuery({
              queryKey: ['entry', universeId, sibling.id],
              queryFn: () => fetchEntryDetail(universeId, sibling.id),
            });
            return [sibling.id, detail.body ?? ''] as const;
          } catch {
            return [sibling.id, ''] as const;
          }
        }),
      );
      if (!cancelled) {
        setSiblingBodies(Object.fromEntries(pairs));
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [allEntries, entry.id, universeId, queryClient]);

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

      // Source body from the detail-fetched corpus, NOT the list-cache row.
      const body: string = siblingBodies[sourceEntry.id] ?? '';
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
  }, [allEntries, entry, siblingBodies]);

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
                  canonicalTitle={entry.title}
                  isPending={pendingId === mentionKey}
                  onPending={() => setPendingId(mentionKey)}
                  onReset={() => setPendingId(null)}
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
 *
 * Body for the splice is fetched fresh from the detail endpoint on click so
 * the PATCH always uses authoritative, non-stale content.
 */
function LinkifyButton({
  universeId,
  mention,
  canonicalTitle,
  isPending,
  onPending,
  onReset,
  onLinked,
}: {
  universeId: string;
  mention: Mention;
  canonicalTitle: string;
  isPending: boolean;
  onPending: () => void;
  onReset: () => void;
  onLinked: () => void;
}) {
  const updateEntry = useUpdateEntry(universeId, mention.sourceEntryId);
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);

  const handleClick = async () => {
    // HI-01: claim the pending slot BEFORE any await so a double-click within
    // the fetch window cannot launch a second concurrent handleClick (the
    // button disables on the first synchronous render after onPending()).
    onPending();
    setError(null);

    // Fetch the authoritative body from the detail endpoint (NOT the list cache).
    // Reuses the existing ['entry', universeId, entryId] cache key — no new key.
    let detail;
    try {
      detail = await queryClient.fetchQuery({
        queryKey: ['entry', universeId, mention.sourceEntryId],
        queryFn: () => fetchEntryDetail(universeId, mention.sourceEntryId),
      });
    } catch {
      // ME-01: network/auth failure — surface real feedback and release the
      // pending slot. Do NOT call onLinked() here: that is the success path and
      // would trigger a misleading refetch with no error shown to the user.
      setError('Could not load the entry — try again.');
      onReset();
      return;
    }

    const body = detail.body ?? '';

    // Splice guard (T-48-05-03): if the body changed under the scanned index
    // (concurrent edit), the slice will not equal matchedText — abort rather
    // than splicing at the wrong position and corrupting unrelated prose.
    if (body.slice(mention.matchIndex, mention.matchIndex + mention.matchLength) !== mention.matchedText) {
      // Stale index — call onLinked so the panel refreshes instead of corrupting.
      onLinked();
      return;
    }

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

    // Pending slot already claimed at the top of handleClick (HI-01).
    updateEntry.mutate(
      { body: newBody },
      {
        onSuccess: () => onLinked(),
        // Without onError the failed PATCH leaves pendingId set, stranding the
        // row permanently disabled. Release it and surface feedback instead.
        onError: () => {
          setError('Could not save the link — try again.');
          onReset();
        },
      },
    );
  };

  return (
    <div className="flex shrink-0 flex-col items-end gap-1">
      <button
        type="button"
        onClick={() => { void handleClick(); }}
        disabled={isPending || updateEntry.isPending}
        className="rounded-md border border-neutral-300 dark:border-neutral-700 text-sm px-3 py-1.5 hover:bg-neutral-50 dark:hover:bg-neutral-800 disabled:opacity-50"
      >
        {isPending || updateEntry.isPending ? 'Linking…' : 'Link'}
      </button>
      {error && (
        <span role="alert" className="text-xs text-red-500">
          {error}
        </span>
      )}
    </div>
  );
}
