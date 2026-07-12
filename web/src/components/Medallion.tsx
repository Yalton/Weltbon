import { useState } from 'react';
import {
  MEDALLION_SIZES,
  resolveMedallion,
  type MedallionSize,
  type MedallionSource,
} from '../lib/medallion';
import { cx } from './ui/cx';

export type MedallionProps = MedallionSource & {
  size: MedallionSize;
  className?: string;
};

/**
 * Content-Forward Views §2 — the HTML identity disc.
 *
 * Cover → circular object-cover image. Icon → emoji on a type-hued disc.
 * Neither → illuminated monogram in font-display, which means it inherits
 * whatever display font the universe's ThemeScope has set.
 *
 * Resolution lives in resolveMedallion (lib/medallion.ts), NOT here — the SVG
 * renderer calls the same function, which is what stops the two drifting apart.
 *
 * Decorative, not announced: in every planned usage the medallion sits directly
 * beside the entry's title text, so its content (a cover thumb, an icon, a
 * monogram) is always redundant with the adjacent, already-announced title.
 * All three variants are therefore decorative — cover uses alt="", the
 * fallback disc uses aria-hidden. Announcing "Aldric" (title) then "Aldric"
 * (image alt) again would just be noise for screen-reader users.
 */
export function Medallion({
  title,
  entryType,
  icon,
  coverThumbUrl,
  size,
  className = '',
}: MedallionProps) {
  // A signed thumb URL can expire, and the backing asset can vanish between the
  // list cache and the paint. Degrade to the monogram rather than show a broken
  // image. Track the specific URL that failed (not just a boolean) so that if
  // this component instance is reused for a new coverThumbUrl — the same entry
  // gets a fresh cover after upload, or a differently-keyed list reuses the
  // slot — the new URL still gets a chance to load instead of being suppressed
  // by a stale failure.
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const effectiveCoverThumbUrl = coverThumbUrl && coverThumbUrl !== failedUrl ? coverThumbUrl : null;
  const m = resolveMedallion({
    title,
    entryType,
    icon,
    coverThumbUrl: effectiveCoverThumbUrl,
  });
  const px = MEDALLION_SIZES[size];

  const base = cx('shrink-0 rounded-full overflow-hidden', className);
  const dims = { width: `${px}px`, height: `${px}px` };

  if (m.kind === 'cover') {
    return (
      <img
        data-medallion="cover"
        src={m.coverUrl!}
        alt=""
        style={dims}
        onError={() => setFailedUrl(coverThumbUrl ?? null)}
        className={cx(base, 'object-cover')}
      />
    );
  }

  return (
    <span
      data-medallion={m.kind}
      aria-hidden="true"
      style={{
        ...dims,
        background: m.html.discBackground,
        boxShadow: `inset 0 0 0 1px ${m.html.ringColor}`,
      }}
      className={cx(base, 'inline-flex items-center justify-center select-none')}
    >
      {m.kind === 'icon' ? (
        <span style={{ fontSize: `${Math.round(px * 0.5)}px`, lineHeight: 1 }}>{m.icon}</span>
      ) : (
        <span
          className="font-display font-semibold text-ink"
          style={{ fontSize: `${Math.round(px * 0.45)}px`, lineHeight: 1 }}
        >
          {m.monogram}
        </span>
      )}
    </span>
  );
}
