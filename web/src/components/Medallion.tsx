import { useState } from 'react';
import {
  MEDALLION_ICON_RATIO,
  MEDALLION_MONOGRAM_RATIO,
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

export function Medallion({
  title,
  entryType,
  icon,
  coverThumbUrl,
  size,
  className = '',
}: MedallionProps) {
  // gets a fresh cover after upload, or a differently-keyed list reuses the
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
    // no non-null assertion needed, and it is the only value that could have produced
    const url = m.coverUrl;
    return (
      <img
        data-medallion="cover"
        src={url}
        alt=""
        style={dims}
        onError={() => setFailedUrl(url)}
        onLoad={() => setFailedUrl(null)}
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
        <span style={{ fontSize: `${Math.round(px * MEDALLION_ICON_RATIO)}px`, lineHeight: 1 }}>
          {m.icon}
        </span>
      ) : (
        <span
          className="font-display font-semibold text-ink"
          style={{ fontSize: `${Math.round(px * MEDALLION_MONOGRAM_RATIO)}px`, lineHeight: 1 }}
        >
          {m.monogram}
        </span>
      )}
    </span>
  );
}
