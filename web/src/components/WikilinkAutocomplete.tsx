/**
 * WikilinkAutocomplete — Phase 47 XREF-01
 *
 * Caret-anchored inline picker that surfaces universe entries (by title + alias)
 * when authoring a `[[` wikilink in the entry editor.
 *
 * Pure helpers are exported so Plan 47-02 (EntryEditor wiring) can compute the
 * same result list deterministically.
 */

import { useState, useEffect, useMemo } from 'react';
import * as Popover from '@radix-ui/react-popover';
import { useEntries, type Entry } from '../hooks/useEntries';

/** D-08: maximum number of result rows the picker surfaces. */
const MAX_RESULTS = 8;

// ---------------------------------------------------------------------------
// Props interface — stable contract for Plan 47-02
// ---------------------------------------------------------------------------

export interface WikilinkAutocompleteProps {
  universeId: string;
  currentEntryId: string | null;
  query: string;
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
  triggerStart: number;
  activeIndex: number;
  onActiveIndexChange: (next: number) => void;
  onResultCountChange: (count: number) => void;
  onSelect: (insertText: string) => void;
  onDismiss: () => void;
  /**
   * CR-01: report the canonical insert string for the currently-active row so the
   * parent's Enter handler inserts exactly what is highlighted — null when there
   * is no active result. The component owns the result list, so this is the only
   * desync-free source for keyboard selection.
   */
  onActiveInsertChange: (insertText: string | null) => void;
}

// ---------------------------------------------------------------------------
// Pure helpers (exported for parent use — Plan 47-02 consumes these)
// ---------------------------------------------------------------------------

/**
 * Rank entries against a query string using a four-tier system:
 *   1. Title prefix (case-insensitive)
 *   2. Alias prefix (case-insensitive)
 *   3. Title substring
 *   4. Alias substring
 *
 * Empty query returns entries sorted by updatedAt descending (recency, D-09).
 * Strips any `|display` pipe suffix from the query before matching (D-05).
 * Self is excluded (D-13). Results capped at 8 (D-08).
 */
export function rankEntries(
  entries: Entry[],
  query: string,
  currentEntryId: string | null,
): Entry[] {
  // Strip pipe suffix — typing [[Title|display should rank on "Title" part only
  const pipeIdx = query.indexOf('|');
  const q = pipeIdx === -1 ? query : query.slice(0, pipeIdx);
  const lower = q.toLowerCase();

  const exclude = (e: Entry) => e.id !== currentEntryId;

  if (!lower) {
    // D-09: empty query → recently-edited entries (updatedAt desc, cap 8)
    return (entries ?? [])
      .filter(exclude)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, MAX_RESULTS);
  }

  const titlePrefix: Entry[] = [];
  const aliasPrefix: Entry[] = [];
  const titleSub: Entry[] = [];
  const aliasSub: Entry[] = [];

  for (const e of entries ?? []) {
    if (!exclude(e)) continue;
    const t = e.title.toLowerCase();
    if (t.startsWith(lower)) {
      titlePrefix.push(e);
      continue;
    }
    const aliasMatch = (e.aliases ?? []).find((a) => a.toLowerCase().startsWith(lower));
    if (aliasMatch) {
      aliasPrefix.push(e);
      continue;
    }
    if (t.includes(lower)) {
      titleSub.push(e);
      continue;
    }
    if ((e.aliases ?? []).some((a) => a.toLowerCase().includes(lower))) {
      aliasSub.push(e);
    }
  }

  return [...titlePrefix, ...aliasPrefix, ...titleSub, ...aliasSub].slice(0, MAX_RESULTS);
}

/**
 * Returns the alias that matched the query, or undefined when:
 *   - the match was by title (not alias)
 *   - the query is empty
 *   - the entry has no aliases
 *
 * Strips pipe suffix from the query before checking (D-05).
 * Used to render the "— alias: <alias>" annotation on result rows (D-07).
 */
export function getMatchedAlias(entry: Entry, query: string): string | undefined {
  // Strip pipe suffix
  const pipeIdx = query.indexOf('|');
  const q = pipeIdx === -1 ? query : query.slice(0, pipeIdx);
  const lower = q.toLowerCase();
  if (!lower) return undefined;
  return (entry.aliases ?? []).find((a) => a.toLowerCase().includes(lower));
}

/**
 * Build the canonical wikilink insert string for a selected entry.
 *
 * - No pipe in query → `[[<entry.title>]]`
 * - Pipe in query → `[[<entry.title><query from | onward>]]` (SC3 / D-05)
 *
 * Always uses the canonical entry title (D-03), regardless of which alias matched.
 */
export function buildInsertString(entry: Entry, query: string): string {
  const pipeIdx = query.indexOf('|');
  if (pipeIdx === -1) {
    return `[[${entry.title}]]`;
  }
  // Preserve everything from the first `|` onward verbatim
  const displaySuffix = query.slice(pipeIdx); // includes the '|' char
  return `[[${entry.title}${displaySuffix}]]`;
}

/**
 * Returns true when the cursor position is inside a fenced or inline code span.
 *
 * Uses an odd-count heuristic:
 *   - If an odd number of ``` markers precede the cursor → inside a fenced block.
 *   - After removing ``` markers, if an odd number of ` precede the cursor →
 *     inside an inline code span.
 *
 * Mirrors the render-side code-span exclusion in WikilinkText.tsx (D-11).
 */
export function isInsideCodeSpan(text: string, cursorPos: number): boolean {
  const before = text.slice(0, cursorPos);

  // Check for fenced code block (``` markers)
  const fenceMatches = before.match(/```/g) ?? [];
  if (fenceMatches.length % 2 !== 0) return true;

  // Check for inline backtick after stripping fence markers
  const withoutFences = before.replace(/```/g, '');
  const backtickMatches = withoutFences.match(/`/g) ?? [];
  return backtickMatches.length % 2 !== 0;
}

// ---------------------------------------------------------------------------
// Private caret coordinate helper (mirror-div technique, zero new deps)
// ---------------------------------------------------------------------------

interface CaretCoords {
  top: number;
  left: number;
}

/**
 * Compute the `{ top, left }` pixel offset of a character position in a textarea,
 * relative to the textarea's offset parent.
 *
 * Uses the mirror-div technique: clones the textarea's font/spacing CSS onto a
 * hidden absolutely-positioned `<div>`, inserts text up to `position`, appends a
 * zero-width `<span>` marker, reads the span's offsetTop/offsetLeft.
 *
 * No `textarea-caret` npm package is used or required.
 */
function getCaretCoordinates(
  textarea: HTMLTextAreaElement,
  position: number,
): CaretCoords {
  const computed = window.getComputedStyle(textarea);

  const div = document.createElement('div');
  div.style.position = 'absolute';
  div.style.visibility = 'hidden';
  div.style.whiteSpace = 'pre-wrap';
  div.style.wordWrap = 'break-word';
  div.style.overflow = 'hidden';

  // Copy all relevant computed styles
  const properties = [
    'font-family',
    'font-size',
    'font-weight',
    'font-style',
    'letter-spacing',
    'line-height',
    'padding-top',
    'padding-right',
    'padding-bottom',
    'padding-left',
    'border-top-width',
    'border-right-width',
    'border-bottom-width',
    'border-left-width',
    'box-sizing',
    'tab-size',
  ] as const;

  for (const prop of properties) {
    div.style.setProperty(prop, computed.getPropertyValue(prop));
  }

  // Match textarea width
  const textareaRect = textarea.getBoundingClientRect();
  div.style.width = `${textareaRect.width}px`;

  // Insert text content up to cursor position
  div.textContent = textarea.value.slice(0, position);

  // Append a marker span
  const span = document.createElement('span');
  span.textContent = '​'; // zero-width space
  div.appendChild(span);

  // Append to body to measure, then clean up. WR-04: removeChild runs in a
  // `finally` so a throw mid-measure (e.g. detached-node offset read in an edge
  // jsdom/SSR path) never leaks the mirror div onto document.body.
  document.body.appendChild(div);
  try {
    return {
      top: span.offsetTop + textarea.offsetTop - textarea.scrollTop,
      left: span.offsetLeft + textarea.offsetLeft,
    };
  } finally {
    document.body.removeChild(div);
  }
}

// ---------------------------------------------------------------------------
// WikilinkAutocomplete component
// ---------------------------------------------------------------------------

export function WikilinkAutocomplete({
  universeId,
  currentEntryId,
  query,
  textareaRef,
  triggerStart,
  activeIndex,
  onActiveIndexChange,
  onResultCountChange,
  onSelect,
  onDismiss,
  onActiveInsertChange,
}: WikilinkAutocompleteProps) {
  const { data: entries = [] } = useEntries(universeId);
  // WR-05: memoize so the result identity is stable across the parent re-renders
  // that the report-up effects trigger — prevents effect thrash / churn.
  const results = useMemo(
    () => rankEntries(entries, query, currentEntryId),
    [entries, query, currentEntryId],
  );

  // Caret coordinates state — updated whenever triggerStart or query changes
  const [caretCoords, setCaretCoords] = useState<CaretCoords>({ top: 0, left: 0 });

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    const coords = getCaretCoordinates(textarea, triggerStart);
    setCaretCoords(coords);
  }, [textareaRef, triggerStart, query]);

  // Report result count to parent (for ArrowKey clamp)
  useEffect(() => {
    onResultCountChange(results.length);
  }, [results.length, onResultCountChange]);

  // CR-01: the component owns the authoritative result list, so it (not the
  // parent) resolves which entry the active row maps to. Report the active row's
  // canonical insert string up so the parent's Enter handler inserts exactly what
  // is highlighted — never a stale re-rank from a second useEntries subscription
  // that may be mid-fetch (empty list → silent no-op, or desync → wrong entry).
  useEffect(() => {
    const active = results[activeIndex];
    onActiveInsertChange(active ? buildInsertString(active, query) : null);
  }, [results, activeIndex, query, onActiveInsertChange]);

  return (
    <Popover.Root open>
      <Popover.Anchor asChild>
        <span
          style={{
            position: 'absolute',
            top: caretCoords.top,
            left: caretCoords.left,
            width: 0,
            height: 0,
            overflow: 'visible',
            pointerEvents: 'none',
          }}
        />
      </Popover.Anchor>
      <Popover.Portal>
        <Popover.Content
          className="min-w-48 max-w-72 max-h-64 overflow-y-auto bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 rounded-md shadow-lg z-50"
          align="start"
          sideOffset={4}
          onOpenAutoFocus={(e) => e.preventDefault()}
        >
          {results.length === 0 ? (
            <p className="px-3 py-2 text-sm text-neutral-500">No matches</p>
          ) : (
            <ul role="listbox">
              {results.map((entry, i) => {
                const matchedAlias = getMatchedAlias(entry, query);
                const isActive = i === activeIndex;
                return (
                  <li
                    key={entry.id}
                    role="option"
                    aria-selected={isActive}
                  >
                    <button
                      type="button"
                      className={`w-full flex items-center gap-1 px-3 py-1.5 text-left text-sm hover:bg-neutral-100 dark:hover:bg-neutral-800 ${
                        isActive ? 'bg-neutral-100 dark:bg-neutral-800' : ''
                      }`}
                      onMouseDown={(e) => {
                        // Use onMouseDown (not onClick) so selection fires before
                        // textarea blur, which would close the popover first
                        e.preventDefault();
                        onSelect(buildInsertString(entry, query));
                      }}
                      onMouseEnter={() => onActiveIndexChange(i)}
                    >
                      <span className="flex-1 truncate">{entry.title}</span>
                      {matchedAlias && (
                        <span className="text-xs text-neutral-500 truncate">
                          {` — alias: ${matchedAlias}`}
                        </span>
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
