import { useState, useRef } from 'react';
import * as Popover from '@radix-ui/react-popover';
import { useNavigate } from 'react-router-dom';
import { useShareMode } from '../contexts/ShareModeContext';

interface WordPopoverProps {
  word: string;
  displayLabel: string;
  gloss: string;
  ipa: string;
  universeId: string;
  languageEntryId?: string | null;
}

export function WordPopover({
  word,
  displayLabel,
  gloss,
  ipa,
  universeId,
  languageEntryId,
}: WordPopoverProps) {
  const navigate = useNavigate();
  const isShareMode = useShareMode();
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
    // T-33-07: no-op in share mode — /universes/share/dictionary is a protected
    // route that would redirect to /login. There is no share-mode dictionary
    if (isShareMode) return;
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
        {isShareMode ? (
          // Share mode: hover-only plain span — no button role, no tabIndex,
          <span
            onMouseEnter={handleMouseEnter}
            onMouseLeave={handleMouseLeave}
            className="rounded px-0.5 bg-[color:var(--color-accent-soft)]"
            aria-label={`${word}: hover to see gloss`}
          >
            {displayLabel}
          </span>
        ) : (
          // Authenticated mode: full click-to-dictionary + keyboard activation.
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
        )}
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          sideOffset={8}
          side="top"
          align="center"
          onMouseEnter={handleMouseEnter}
          onMouseLeave={handleMouseLeave}
          className="bg-panel border border-line rounded-md shadow-lg p-3 z-50 max-w-[280px] data-[state=open]:animate-popover-in data-[state=closed]:animate-popover-out focus:outline-none"
        >
          <div>
            <span className="font-semibold text-sm">{word}</span>
            {ipa && (
              <span className="block font-mono text-ink-muted text-sm mt-0.5">
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
