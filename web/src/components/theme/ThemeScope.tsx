import type { CSSProperties, HTMLAttributes } from 'react';
import { themeToCssVars } from '../../lib/theme/palettes';
import type { UniverseTheme } from '../../types/theme';

const SCRIM_GRADIENT =
  'linear-gradient(180deg, rgb(7 9 18 / 0.78) 0%, rgb(7 9 18 / 0.55) 35%, rgb(7 9 18 / 0.55) 65%, rgb(7 9 18 / 0.78) 100%)';

// Night sky is flat: the palette's mid tone, no vignette.
const CANVAS_FILL = 'var(--color-canvas-mid)';

export function ThemeScope({
  theme,
  backdropUrl = null,
  backdropMode = 'viewport',
  showCanvas = true,
  className = '',
  style,
  children,
  ...rest
}: HTMLAttributes<HTMLDivElement> & {
  theme: UniverseTheme | null | undefined;
  backdropUrl?: string | null;
  backdropMode?: 'viewport' | 'contained';
  showCanvas?: boolean;
}) {
  const vars = themeToCssVars(theme);
  const hasTheme = Object.keys(vars).length > 0;
  const contained = backdropMode === 'contained';

  let layers = null;
  if (backdropUrl) {
    layers = contained ? (
      <div
        aria-hidden="true"
        className="absolute inset-0 -z-10 overflow-hidden rounded-[inherit]"
      >
        <img
          data-testid="theme-backdrop"
          src={backdropUrl}
          alt=""
          className="absolute inset-0 h-full w-full object-cover"
        />
        <div
          data-testid="theme-scrim"
          className="absolute inset-0"
          style={{ background: SCRIM_GRADIENT }}
        />
      </div>
    ) : (
      <>
        <img
          data-testid="theme-backdrop"
          src={backdropUrl}
          alt=""
          aria-hidden="true"
          className="fixed inset-0 -z-20 h-full w-full object-cover"
        />
        <div
          data-testid="theme-scrim"
          aria-hidden="true"
          className="fixed inset-0 -z-10"
          style={{ background: SCRIM_GRADIENT }}
        />
      </>
    );
  } else if (showCanvas && hasTheme) {
    layers = contained ? (
      <div
        aria-hidden="true"
        className="absolute inset-0 -z-10 overflow-hidden rounded-[inherit]"
      >
        <div
          data-testid="theme-canvas"
          className="absolute inset-0"
          style={{ background: CANVAS_FILL }}
        />
      </div>
    ) : (
      <div
        data-testid="theme-canvas"
        aria-hidden="true"
        className="fixed inset-0 -z-20"
        style={{ background: CANVAS_FILL }}
      />
    );
  }

  return (
    <div {...rest} data-theme-scope="" className={className} style={{ ...(vars as CSSProperties), ...style }}>
      {layers}
      {children}
    </div>
  );
}
