import ReactMarkdown, { defaultUrlTransform } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { WikilinkText } from './WikilinkText';
import type { WikilinkResolutionData } from './WikilinkText';

/**
 * URL transform that passes asset:// URLs through to the components.img
 * override unchanged. All other URLs go through react-markdown's default
 * sanitisation (allows http/https/mailto/tel; blocks javascript: etc.).
 *
 * Phase 38 MEDIA-05: without this, react-markdown v10's defaultUrlTransform
 * returns '' for unrecognized schemes, causing src="" on asset:// embeds.
 *
 * Note: defaultUrlTransform is declared as (value: string) => string but called
 * internally with (value, key, node). We only call it with value to stay
 * within the typed API surface.
 */
function urlTransformWithAssets(url: string): string {
  if (url.startsWith('asset://')) return url;
  return defaultUrlTransform(url);
}

// Re-export so callers can import the type from the MarkdownRenderer module.
export type { WikilinkResolutionData };

/**
 * Phase 32 Plan 04 — extended MarkdownRenderer with optional `wikis` prop.
 *
 * When `wikis` is provided:
 *   - `components.p` and `components.li` are overridden to wrap their children
 *     in `WikilinkText`, which tokenises `[[word]]` tokens and renders resolved
 *     entry links, WordPopovers, or unresolved amber affordances.
 *   - `code`/`pre` are NOT overridden, so inline code spans never reach
 *     WikilinkText — code-span exclusion is guaranteed structurally.
 *
 * When `wikis` is absent:
 *   - Behavior is unchanged from the pre-Plan-04 version; `[[...]]` renders
 *     as literal text. All existing callers are unaffected (backwards-compat).
 *
 * Phase 38 Plan 03 — extended with optional `assets` prop (MEDIA-05).
 *
 * When `assets` is provided:
 *   - `components.img` is overridden to intercept `src` starting with `asset://`.
 *   - For `asset://uuid` srcs: builds `/api/universes/:uid/assets/:id/raw` (authed)
 *     or `/api/share/assets/:id/raw` (share mode, Pitfall 4 — <img src> bypasses
 *     the api() client rewrite seam, so URL must be built explicitly).
 *   - For other srcs: passes through as a plain <img>.
 *   - onError hides the broken img via display:none. No /missing-image.svg exists
 *     (D-12 graceful missing-image placeholder via hide).
 *
 * T-32-12 XSS: uuid is concatenated into a URL path only — never
 * dangerouslySetInnerHTML. react-markdown sanitises before calling img component.
 * T-38-20: asset:// uuid → URL path; no injection vector.
 * T-38-21: share mode builds /api/share/assets/:id/raw explicitly (Pitfall 4).
 * T-38-22: onError hides the img; inline refs left in body intentionally (D-12).
 */
export function MarkdownRenderer({
  content,
  wikis,
  assets,
}: {
  content: string;
  wikis?: WikilinkResolutionData;
  assets?: { universeId: string; shareToken?: string | null };
}) {
  // Build the img component override only when `assets` prop is provided.
  const imgComponent = assets
    ? ({ src, alt }: { src?: string; alt?: string }) => {
        if (src?.startsWith('asset://')) {
          const uuid = src.slice('asset://'.length);
          // Share mode: <img src> is a direct browser fetch, NOT an api() call.
          // The api() client /universes/<uid> → /api/share rewrite does NOT apply
          // here. Build the share URL explicitly (Pitfall 4 / T-38-21).
          const rawUrl = assets.shareToken
            ? `/api/share/assets/${uuid}/raw`
            : `/api/universes/${assets.universeId}/assets/${uuid}/raw`;
          return (
            <img
              src={rawUrl}
              alt={alt ?? ''}
              className="max-w-full rounded"
              onError={(e) => {
                // No /missing-image.svg asset exists — hide the broken img
                // rather than swap src (D-12 graceful missing-image, T-38-22).
                (e.target as HTMLImageElement).style.display = 'none';
              }}
            />
          );
        }
        // Non-asset:// src — pass through as a plain img (external URLs etc.)
        return <img src={src} alt={alt ?? ''} />;
      }
    : undefined;

  const components = {
    ...(wikis
      ? {
          // Wrap p and li children in WikilinkText so [[word]] tokens are
          // tokenised in their text segments. Code spans are React elements
          // (not plain strings) inside these containers, so they pass through
          // WikilinkText unchanged — code-span exclusion holds.
          p: ({ children }: { children?: React.ReactNode }) => (
            <p>
              <WikilinkText wikis={wikis}>{children}</WikilinkText>
            </p>
          ),
          li: ({ children }: { children?: React.ReactNode }) => (
            <li>
              <WikilinkText wikis={wikis}>{children}</WikilinkText>
            </li>
          ),
        }
      : {}),
    ...(imgComponent ? { img: imgComponent } : {}),
  };

  // Pass undefined (not an empty object) to ReactMarkdown when no overrides —
  // avoids triggering extra re-renders and preserves pre-Phase-32 behaviour.
  const resolvedComponents =
    Object.keys(components).length > 0 ? components : undefined;

  return (
    <div className="prose prose-neutral dark:prose-invert max-w-none">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={resolvedComponents}
        // Pass through asset:// URLs so the components.img override receives
        // the full src string. When assets prop is not provided, use default
        // URL transform (security-preserving; blocks javascript: etc.).
        urlTransform={assets ? urlTransformWithAssets : defaultUrlTransform}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
