import { useState, useRef } from 'react';
import * as Popover from '@radix-ui/react-popover';
import { useShareMode } from '../contexts/ShareModeContext';
import { useEntry } from '../hooks/useEntries';
import { TypeBadge } from './TypeBadge';
import type { Entry } from '../hooks/useEntries';

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------

interface EntryHoverCardProps {
  entry: Entry;
  universeId: string;
  children: React.ReactNode;
}

// ---------------------------------------------------------------------------
// Markdown-strip helper (D-13 body excerpt — plain text only, XSS-safe)
// ---------------------------------------------------------------------------

function stripMarkdown(body: string): string {
  let text = body;
  text = text.replace(/```[\s\S]*?```/g, '');
  text = text.replace(/<[^>]+>/g, '');
  text = text.replace(/^#{1,6}\s+/gm, '');
  text = text.replace(/!\[[^\]]*\]\([^)]*\)/g, '');
  text = text.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');
  text = text.replace(/`[^`]*`/g, '');
  text = text.replace(/\*{1,3}([^*]+)\*{1,3}/g, '$1');
  text = text.replace(/_{1,3}([^_]+)_{1,3}/g, '$1');
  text = text.replace(/^>\s*/gm, '');
  text = text.replace(/^[-*_]{3,}\s*$/gm, '');
  text = text.replace(/\s+/g, ' ').trim();
  if (text.length > 200) {
    const cut = text.lastIndexOf(' ', 200);
    text = text.slice(0, cut > 0 ? cut : 200) + '…';
  }
  return text;
}

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------

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
  const lazyEntryId = open && !summaryPresent ? entry.id : '';
  const { data: lazyEntry, isLoading: lazyLoading } = useEntry(universeId, lazyEntryId);

  // - summary present → use it directly
  // - summary absent + body fetched → markdown-stripped excerpt
  // - summary absent + loading → placeholder
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
          className="entry-hover-caret inline-flex items-center justify-center w-4 h-4 text-xs text-ink-secondary hover:text-ink cursor-pointer select-none"
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
          className="bg-panel border border-line rounded-md shadow-lg z-50 max-w-[300px] overflow-hidden data-[state=open]:animate-popover-in data-[state=closed]:animate-popover-out focus:outline-none"
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
                  className="font-semibold text-sm text-ink leading-tight truncate"
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
                className="text-sm text-ink-secondary line-clamp-3 mt-1"
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
