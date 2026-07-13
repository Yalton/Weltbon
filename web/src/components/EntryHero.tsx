import type { ReactNode } from 'react';
import type { ResolvedMedallion } from '../lib/medallion';

/**
 * Content-Forward Views §5 — the hero shell shared by the entry detail page and the editor.
 *
 * The height model is the load-bearing part, and it is why this is ONE component rather than
 * two near-identical copies: the visual layer (cover img / hue band) is `absolute inset-0` and
 * the CHILDREN are in flow, so the content defines the box. An earlier version put the content
 * in an absolutely-positioned overlay inside a fixed-height band — which clipped the title's
 * ascenders, and collapsed the whole hero to zero height whenever a (routinely expiring) signed
 * cover URL failed to load, erasing the entry's entire identity from the page. Keep the children
 * in flow. `min-h-24` floors the bare band; `max-h-[300px]` caps a tall cover.
 *
 * Callers differ only in the image source, the alt text, and the in-flow content: the detail
 * page puts the title + badges there, the editor puts the cover action buttons there (so the
 * affordance can never be clipped by a failed image load either).
 */
export function EntryHero({
  testId,
  coverSrc,
  coverAlt,
  medallion,
  className = '',
  children,
}: {
  /** Each caller keeps its own testid ('entry-hero' / 'editor-hero'); tests depend on them. */
  testId: string;
  coverSrc: string | null;
  coverAlt: string;
  /** The no-cover identity: supplies the type hue + the watermark glyph (cover → icon → monogram). */
  medallion: ResolvedMedallion;
  /** Caller-owned outer spacing — lets the detail page keep its `mt-4` without the editor inheriting it. */
  className?: string;
  children: ReactNode;
}) {
  return (
    <div
      data-testid={testId}
      className={`relative min-h-24 max-h-[300px] overflow-hidden rounded-xl border border-glass-border ${className}`}
    >
      {coverSrc ? (
        <img
          src={coverSrc}
          alt={coverAlt}
          className="absolute inset-0 h-full w-full object-cover"
          onError={(e) => {
            // Signed cover URLs expire (24h TTL), so a broken cover is a normal state, not an
            // edge case. Hiding the img is safe precisely because the children are in flow.
            (e.target as HTMLImageElement).style.display = 'none';
          }}
        />
      ) : (
        // No cover: a band tinted with the entry-type hue, carrying an oversized watermark of the
        // entry's identity glyph. Deliberately NO scrim over this branch — the band is already a
        // low-alpha gradient on the page surface, and a from-black/70 wash would both mute the hue
        // and swallow the watermark. The content reads on the band unaided.
        <div className="absolute inset-0" style={{ background: medallion.html.discBackground }}>
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
