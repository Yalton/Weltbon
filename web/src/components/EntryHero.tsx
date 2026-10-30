import type { ReactNode } from 'react';
import type { ResolvedMedallion } from '../lib/medallion';

export function EntryHero({
  testId,
  coverSrc,
  coverAlt,
  medallion,
  className = '',
  children,
}: {
  testId: string;
  coverSrc: string | null;
  coverAlt: string;
  medallion: ResolvedMedallion;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div
      data-testid={testId}
      className={`relative min-h-24 max-h-[300px] overflow-hidden rounded-lg border border-line ${className}`}
    >
      {coverSrc ? (
        <img
          src={coverSrc}
          alt={coverAlt}
          className="absolute inset-0 h-full w-full object-cover"
          onError={(e) => {
            (e.target as HTMLImageElement).style.display = 'none';
          }}
        />
      ) : (
        // No cover: a flat panel carrying an oversized watermark of the entry's mark in the
        // entry-type hue. Tinting the panel itself with a warm hue greys out the navy.
        <div className="absolute inset-0 bg-panel">
          {/* The identity contract (lib/medallion) resolves cover → icon → monogram, and the list
              rows and graph nodes draw the icon tier — so the watermark honours it too: an entry
              with an emoji watermarks the emoji, not a letter it never chose. */}
          <span
            aria-hidden="true"
            data-testid="hero-monogram"
            className="pointer-events-none absolute right-4 top-1/2 -translate-y-1/2 select-none font-display text-[5rem] font-semibold leading-none opacity-20"
            style={{ color: medallion.hue }}
          >
            {medallion.kind === 'icon' ? medallion.icon : medallion.monogram}
          </span>
        </div>
      )}

      {/* Scrim — only over a cover, where the content would otherwise sit on arbitrary pixels.
          pointer-events-none so it can never intercept clicks meant for the content. */}
      {coverSrc && (
        <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-black/70 via-black/20 to-transparent" />
      )}

      {/* In flow (relative, so it stacks above the absolute visual layer): this is what gives the
          hero its height. Callers own the padding of their own content. */}
      <div className="relative">{children}</div>
    </div>
  );
}
