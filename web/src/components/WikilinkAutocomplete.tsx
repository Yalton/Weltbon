
import { useState, useEffect, useMemo } from 'react';
import * as Popover from '@radix-ui/react-popover';
import { useEntries, type Entry } from '../hooks/useEntries';

const MAX_RESULTS = 8;

// ---------------------------------------------------------------------------
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
  onActiveInsertChange: (insertText: string | null) => void;
}

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------

export function rankEntries(
  entries: Entry[],
  query: string,
  currentEntryId: string | null,
): Entry[] {
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

export function getMatchedAlias(entry: Entry, query: string): string | undefined {
  const pipeIdx = query.indexOf('|');
  const q = pipeIdx === -1 ? query : query.slice(0, pipeIdx);
  const lower = q.toLowerCase();
  if (!lower) return undefined;
  return (entry.aliases ?? []).find((a) => a.toLowerCase().includes(lower));
}

export function buildInsertString(entry: Entry, query: string): string {
  const pipeIdx = query.indexOf('|');
  if (pipeIdx === -1) {
    return `[[${entry.title}]]`;
  }
  const displaySuffix = query.slice(pipeIdx); // includes the '|' char
  return `[[${entry.title}${displaySuffix}]]`;
}

export function isInsideCodeSpan(text: string, cursorPos: number): boolean {
  const before = text.slice(0, cursorPos);

  const fenceMatches = before.match(/```/g) ?? [];
  if (fenceMatches.length % 2 !== 0) return true;

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

  const textareaRect = textarea.getBoundingClientRect();
  div.style.width = `${textareaRect.width}px`;

  div.textContent = textarea.value.slice(0, position);

  const span = document.createElement('span');
  span.textContent = '​'; // zero-width space
  div.appendChild(span);

  // Append to body to measure, then clean up. WR-04: removeChild runs in a
  // `finally` so a throw mid-measure (e.g. detached-node offset read in an edge
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

  const [caretCoords, setCaretCoords] = useState<CaretCoords>({ top: 0, left: 0 });

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    const coords = getCaretCoordinates(textarea, triggerStart);
    setCaretCoords(coords);
  }, [textareaRef, triggerStart, query]);

  useEffect(() => {
    onResultCountChange(results.length);
  }, [results.length, onResultCountChange]);

  // CR-01: the component owns the authoritative result list, so it (not the
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
          className="min-w-48 max-w-72 max-h-64 overflow-y-auto bg-panel border border-line rounded-md shadow-lg z-50"
          align="start"
          sideOffset={4}
          onOpenAutoFocus={(e) => e.preventDefault()}
        >
          {results.length === 0 ? (
            <p className="px-3 py-2 text-sm text-ink-muted">No matches</p>
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
                      className={`w-full flex items-center gap-1 px-3 py-1.5 text-left text-sm hover:bg-white/5 ${
                        isActive ? ' bg-raised' : ''
                      }`}
                      onMouseDown={(e) => {
                        e.preventDefault();
                        onSelect(buildInsertString(entry, query));
                      }}
                      onMouseEnter={() => onActiveIndexChange(i)}
                    >
                      <span className="flex-1 truncate">{entry.title}</span>
                      {matchedAlias && (
                        <span className="text-xs text-ink-muted truncate">
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
