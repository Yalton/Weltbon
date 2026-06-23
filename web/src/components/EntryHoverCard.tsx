import { useState, useRef } from 'react';
import * as Popover from '@radix-ui/react-popover';
import { useShareMode } from '../contexts/ShareModeContext';
import { useEntry } from '../hooks/useEntries';
import { TypeBadge } from './TypeBadge';
import type { Entry } from '../hooks/useEntries';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface EntryHoverCardProps {
  /**
   * The full list Entry object (title, entryType, summary, icon, coverImageId).
   * Body is NOT on the list entry — it is lazily fetched when the card opens
   * and summary is empty (D-13 fallback).
   */
  entry: Entry;
  /**
   * Universe id — used for authed cover-image URL construction and the D-13
   * lazy body fetch (passed to useEntry).
   */
  universeId: string;
  /**
   * The resolved entry <Link> to wrap as the hover trigger (D-01).
   * The card wraps this element and never calls preventDefault/stopPropagation
   * on its click — navigation is always preserved.
   */
  children: React.ReactNode;
}

// ---------------------------------------------------------------------------
// Markdown-strip helper (D-13 body excerpt — plain text only, XSS-safe)
// ---------------------------------------------------------------------------

/**
 * Strip markdown syntax to plain text and return a short excerpt.
 * Used for the D-13 empty-summary fallback so the card shows a real excerpt
 * rather than an empty summary region.
 *
 * Strips: headings (#), bold/italic (*_), inline code (`), links ([text](url)),
 * images (![alt](url)), blockquotes (>), horizontal rules (---), HTML tags.
 * Collapses whitespace and trims to ~200 characters.
 *
 * T-46-04: all output is plain text — XSS-safe React elements only (no raw HTML injection).
 */
function stripMarkdown(body: string): string {
  let text = body;
  // Remove fenced code blocks
  text = text.replace(/```[\s\S]*?```/g, '');
  // Remove HTML tags
  text = text.replace(/<[^>]+>/g, '');
  // Remove headings (# Heading)
  text = text.replace(/^#{1,6}\s+/gm, '');
  // Remove images ![alt](url)
  text = text.replace(/!\[[^\]]*\]\([^)]*\)/g, '');
  // Convert links [text](url) → text
  text = text.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');
  // Remove inline code
  text = text.replace(/`[^`]*`/g, '');
  // Remove bold/italic (**, __, *, _)
  text = text.replace(/\*{1,3}([^*]+)\*{1,3}/g, '$1');
  text = text.replace(/_{1,3}([^_]+)_{1,3}/g, '$1');
  // Remove blockquotes
  text = text.replace(/^>\s*/gm, '');
  // Remove horizontal rules
  text = text.replace(/^[-*_]{3,}\s*$/gm, '');
  // Collapse whitespace
  text = text.replace(/\s+/g, ' ').trim();
  // Truncate to ~200 characters at a word boundary
  if (text.length > 200) {
    const cut = text.lastIndexOf(' ', 200);
    text = text.slice(0, cut > 0 ? cut : 200) + '…';
  }
  return text;
}

// ---------------------------------------------------------------------------
// EntryHoverCard component
// ---------------------------------------------------------------------------

/**
 * Phase 46 Plan 02 — XREF-02 entry hover-preview card.
 *
 * Wraps the resolved entry `<Link>` (passed as children) in a Radix Popover.
 * The card opens on hover (150ms delay, D-02), keyboard focus (D-03), or a
 * tap on the ⓘ caret affordance (D-04, coarse-pointer only).
 * Click always navigates — the card never intercepts (D-01).
 *
 * Card content (mini entry-detail header):
 *   - Cover image banner when coverImageId is set (D-12); omitted otherwise (D-13)
 *   - entry.icon + title + TypeBadge
 *   - Summary line-clamped to ~3 lines (D-11)
 *   - D-13 fallback: when summary is empty, lazily fetches body via useEntry
 *     (gated on card-open + empty summary) and shows a markdown-stripped excerpt.
 *
 * T-46-04 XSS: all content is plain-text React children — XSS-safe, no raw HTML injection.
 * T-46-05 Private-entry: entriesById is sourced from the is_public-filtered
 *   useEntries list; the lazy body fetch goes to the share seam when in share mode.
 * T-46-06 Cover-image 404: onError hides the broken <img> element.
 * T-46-07 Click-hijack: no preventDefault/stopPropagation on the trigger child.
 * T-46-12 Fetch storm: useEntry is enabled ONLY when card is open AND summary empty.
 */
export function EntryHoverCard({
  entry,
  universeId,
  children,
}: EntryHoverCardProps) {
  const isShareMode = useShareMode();
  const [open, setOpen] = useState(false);
  const openTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Determine whether a lazy body fetch is needed (D-13 fallback gate).
  const summaryPresent = entry.summary.trim().length > 0;
  // Gate the fetch: only when card is open AND summary is empty (T-46-12).
  // Passing '' to useEntry disables it via `enabled: !!universeId && !!entryId`.
  const lazyEntryId = open && !summaryPresent ? entry.id : '';
  const { data: lazyEntry, isLoading: lazyLoading } = useEntry(universeId, lazyEntryId);

  // Compute the displayed summary text:
  //   - summary present → use it directly
  //   - summary absent + body fetched → markdown-stripped excerpt
  //   - summary absent + loading → placeholder
  let summaryText: string;
  if (summaryPresent) {
    summaryText = entry.summary;
  } else if (lazyLoading) {
    summaryText = '…';
  } else if (lazyEntry?.body) {
    summaryText = stripMarkdown(lazyEntry.body);
  } else {
    summaryText = '';
  }

  // ---------------------------------------------------------------------------
  // Hover/focus timer handlers (D-02 — 150ms open, 100ms close grace)
  // Cloned from WordPopover.tsx:51-69 (the proven timer pattern).
  // ---------------------------------------------------------------------------

  function handleMouseEnter() {
    if (closeTimerRef.current) {
      clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
    openTimerRef.current = setTimeout(() => {
      setOpen(true);
    }, 150);
  }

  function handleMouseLeave() {
    if (openTimerRef.current) {
      clearTimeout(openTimerRef.current);
      openTimerRef.current = null;
    }
    closeTimerRef.current = setTimeout(() => {
      setOpen(false);
    }, 100);
  }

  // D-03: keyboard focus/blur on the trigger Link opens/closes the card.
  // The Link is already the focus target — no extra tab stop needed.
  const handleFocus = handleMouseEnter;
  const handleBlur = handleMouseLeave;

  // D-04: caret click opens immediately (no timer delay for touch users).
  function handleCaretClick(e: React.MouseEvent) {
    e.stopPropagation(); // caret click should not bubble to parent; still OK per D-01 (link is sibling, not parent)
    if (openTimerRef.current) {
      clearTimeout(openTimerRef.current);
      openTimerRef.current = null;
    }
    setOpen(true);
  }

  // Cover image URL — built client-side from coverImageId (Phase 38 pattern).
  // <img src> bypasses the api() seam so the URL must be explicit (Phase 38 Pitfall 4 / T-38-21).
  const coverSrc = entry.coverImageId
    ? isShareMode
      ? `/api/share/assets/${entry.coverImageId}/raw`
      : `/api/universes/${universeId}/assets/${entry.coverImageId}/raw`
    : null;

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      {/*
        Wrap trigger + caret in an inline container.
        The Link child (children) is the sole trigger — asChild forwards the
        Popover trigger ref onto it without adding a DOM element.
        D-01: we do NOT add onClick/preventDefault to the child; navigation is sacred.
        D-03: onFocus/onBlur on the trigger wrapper open/close the card.
      */}
      <span
        className="inline-flex items-center gap-0.5"
        style={{ display: 'inline-flex' }}
      >
        <Popover.Trigger asChild>
          {/* Wrap children in a span to attach hover/focus handlers without touching the Link DOM node */}
          <span
            onMouseEnter={handleMouseEnter}
            onMouseLeave={handleMouseLeave}
            onFocus={handleFocus}
            onBlur={handleBlur}
            className="inline"
          >
            {children}
          </span>
        </Popover.Trigger>

        {/*
          D-04: ⓘ caret affordance — visible only under coarse-pointer / no-hover
          devices via CSS media queries. Desktop hover users never see it.
          The `entry-hover-caret` data-testid enables unit testing from jsdom
          (which has no real media query matching).
        */}
        {/*
          D-04 caret: hidden on fine-pointer/hover devices; visible on coarse-pointer
          and no-hover devices. Media gate in global CSS:
            @media (hover: none), (pointer: coarse) { .entry-hover-caret { display: inline-flex; } }
          Outside those media queries (standard desktop) the caret is hidden.
          jsdom tests always see it (no media query matching in jsdom).
        */}
        <span
          data-testid="entry-hover-caret"
          onClick={handleCaretClick}
          role="button"
          tabIndex={-1}
          aria-label={`Preview ${entry.title}`}
          className="entry-hover-caret inline-flex items-center justify-center w-4 h-4 text-xs text-neutral-400 hover:text-neutral-600 dark:hover:text-neutral-300 cursor-pointer select-none"
        >
          ⓘ
        </span>
      </span>

      <Popover.Portal>
        {/*
          D-02: onMouseEnter/onMouseLeave on Content keeps the card open when
          the user moves the mouse from the trigger onto the card.
          Cloned from WordPopover.tsx:119-139.
        */}
        <Popover.Content
          sideOffset={8}
          side="top"
          align="center"
          onMouseEnter={handleMouseEnter}
          onMouseLeave={handleMouseLeave}
          className="bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 rounded-md shadow-lg z-50 max-w-[300px] overflow-hidden data-[state=open]:animate-popover-in data-[state=closed]:animate-popover-out focus:outline-none"
        >
          {/*
            D-12: Cover image banner — rendered only when coverImageId is set.
            D-13: omit the banner region entirely when no cover (no reserved space).
            T-46-06: onError hides a broken/missing image.
          */}
          {coverSrc && (
            <div className="w-full" style={{ maxHeight: '120px', overflow: 'hidden' }}>
              <img
                src={coverSrc}
                alt={`Cover image for ${entry.title}`}
                className="w-full object-cover"
                style={{ maxHeight: '120px' }}
                onError={(e) => {
                  (e.target as HTMLImageElement).style.display = 'none';
                }}
              />
            </div>
          )}

          <div className="p-3">
            {/* Header: icon + title + TypeBadge (mini entry-detail-header feel) */}
            <div className="flex items-start gap-2 mb-1.5">
              {entry.icon && (
                <span className="text-lg leading-none shrink-0">{entry.icon}</span>
              )}
              <div className="flex-1 min-w-0">
                <p
                  data-testid="entry-card-title"
                  className="font-semibold text-sm text-neutral-900 dark:text-neutral-100 leading-tight truncate"
                >
                  {entry.title}
                </p>
                <div className="mt-0.5">
                  <TypeBadge type={entry.entryType} />
                </div>
              </div>
            </div>

            {/*
              D-11: Summary line-clamped to ~3 lines.
              D-13: when summary is empty, shows the lazy body-derived excerpt.
              All text is plain-text React children — T-46-04 XSS-safe.
            */}
            {summaryText && (
              <p
                data-testid="entry-card-summary"
                className="text-sm text-neutral-600 dark:text-neutral-400 line-clamp-3 mt-1"
              >
                {summaryText}
              </p>
            )}
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
