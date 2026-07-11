import type { CSSProperties, HTMLAttributes } from 'react';
import { themeToCssVars } from '../../lib/theme/palettes';
import type { UniverseTheme } from '../../types/theme';

/**
 * Applies a universe theme by overriding the design-token CSS variables on a
 * wrapper element (spec §2.2). Renders the theme's background layers:
 *  - backdropUrl set  → full-bleed image + fixed dark scrim (sim is NOT
 *    rendered by the host layout in this case — host's responsibility).
 *  - theme set, no backdrop → a canvas-gradient layer in the palette's colors
 *    (needed because body's gradient resolves vars outside this scope).
 *  - null/empty theme → no extra layers; global defaults show through.
 * backdropMode 'viewport' (default) uses fixed positioning for page shells;
 * 'contained' uses absolute positioning for card-scoped previews (host must
 * be `relative overflow-hidden`).
 */
export function ThemeScope({
  theme,
  backdropUrl = null,
  backdropMode = 'viewport',
  className = '',
  style,
  children,
  ...rest
}: HTMLAttributes<HTMLDivElement> & {
  theme: UniverseTheme | null | undefined;
  backdropUrl?: string | null;
  backdropMode?: 'viewport' | 'contained';
}) {
  const vars = themeToCssVars(theme);
  const hasTheme = Object.keys(vars).length > 0;
  const pos = backdropMode === 'viewport' ? 'fixed' : 'absolute';

  return (
    <div {...rest} className={className} style={{ ...(vars as CSSProperties), ...style }}>
      {backdropUrl ? (
        <>
          <img
            data-testid="theme-backdrop"
            src={backdropUrl}
            alt=""
            aria-hidden="true"
            className={`${pos} inset-0 -z-20 h-full w-full object-cover`}
          />
          <div
            data-testid="theme-scrim"
            aria-hidden="true"
            className={`${pos} inset-0 -z-10`}
            style={{
              background:
                'linear-gradient(180deg, rgb(7 9 18 / 0.78) 0%, rgb(7 9 18 / 0.55) 35%, rgb(7 9 18 / 0.55) 65%, rgb(7 9 18 / 0.78) 100%)',
            }}
          />
        </>
      ) : hasTheme ? (
        <div
          data-testid="theme-canvas"
          aria-hidden="true"
          className={`${pos} inset-0 -z-20`}
          style={{
            background:
              'radial-gradient(140% 110% at 25% -10%, var(--color-canvas-hi) 0%, var(--color-canvas-mid) 50%, var(--color-canvas-lo) 100%)',
          }}
        />
      ) : null}
      {children}
    </div>
  );
}
