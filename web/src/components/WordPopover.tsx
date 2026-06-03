import { useState, useRef } from 'react';
import * as Popover from '@radix-ui/react-popover';
import { useNavigate } from 'react-router-dom';

interface WordPopoverProps {
  word: string;
  displayLabel: string;
  gloss: string;
  ipa: string;
  universeId: string;
  /** If set, the dictionary navigate URL includes ?lid=<languageEntryId>. */
  languageEntryId?: string | null;
}

/**
 * Phase 32 Plan 04 — D-04 WordPopover.
 *
 * Trigger: the resolved `[[word]]` span (role=button, tabIndex 0,
 * bg var(--color-accent-soft), cursor-pointer).
 *
 * Hover opens after 150ms; mouse-leave closes with 100ms grace.
 * Click navigates directly to the dictionary row (?highlight=<word>).
 *
 * Radix Popover shell mirrors InFlightAuditsBadge.tsx (sideOffset=8,
 * side="top" preferred). Word term: font-semibold 600. IPA: font-mono
 * text-neutral-500. Gloss: body text.
 *
 * T-32-12 XSS: all content is plain-text props; no dangerouslySetInnerHTML.
 */
export function WordPopover({
  word,
  displayLabel,
  gloss,
  ipa,
  universeId,
  languageEntryId,
}: WordPopoverProps) {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const openTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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

  function handleClick() {
    const params = new URLSearchParams();
    if (languageEntryId) params.set('lid', languageEntryId);
    params.set('highlight', word);
    navigate(`/universes/${universeId}/dictionary?${params.toString()}`);
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      handleClick();
    }
  }

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <span
          role="button"
          tabIndex={0}
          onClick={handleClick}
          onKeyDown={handleKeyDown}
          onMouseEnter={handleMouseEnter}
          onMouseLeave={handleMouseLeave}
          className="rounded px-0.5 cursor-pointer bg-[color:var(--color-accent-soft)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--color-accent)]"
          aria-label={`${word}: hover to see gloss`}
        >
          {displayLabel}
        </span>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          sideOffset={8}
          side="top"
          align="center"
          onMouseEnter={handleMouseEnter}
          onMouseLeave={handleMouseLeave}
          className="bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 rounded-md shadow-lg p-3 z-50 max-w-[280px] data-[state=open]:animate-popover-in data-[state=closed]:animate-popover-out focus:outline-none"
        >
          <div>
            <span className="font-semibold text-sm">{word}</span>
            {ipa && (
              <span className="block font-mono text-neutral-500 text-sm mt-0.5">
                <span className="sr-only">IPA: </span>
                {ipa}
              </span>
            )}
            <span className="block text-sm mt-1">{gloss}</span>
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
