import ReactMarkdown, { defaultUrlTransform, type ExtraProps } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import React from 'react';
import { WikilinkText, tokenize } from './WikilinkText';
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

/**
 * Phase 46 CR-01 — detect whether a paragraph's children contain a top-level
 * `![[entry]]` embed that WikilinkText will expand into a block-level callout.
 *
 * EntryEmbed renders a block `<div>` (plus a recursively-rendered `<p>`) for a
 * resolved embed. react-markdown's `p` node would otherwise wrap that block in
 * a `<p>`, which is invalid DOM nesting: React 19 logs a hydration error and
 * the browser HTML parser reparents the callout out of position, silently
 * breaking the XREF-03 reading-surface layout. When this returns true the `p`
 * override below renders a `<div>` wrapper instead, which is a valid block
 * container for the embed callout.
 *
 * Embeds only expand to a block at top level. At `embedDepth === 1` they
 * flatten to inline hover-card links (D-05), which are valid inside `<p>`, so
 * this returns false there and the normal `<p>` wrapper is preserved.
 */
function paragraphHasBlockEmbed(
  children: React.ReactNode,
  wikis: WikilinkResolutionData,
): boolean {
  if (wikis.embedDepth === 1) return false;
  const scan = (node: React.ReactNode): boolean => {
    // Only string children are tokenised by WikilinkText; code spans and other
    // elements arrive as non-string nodes and never produce an embed.
    if (typeof node === 'string') {
      return tokenize(node).some((seg) => seg.kind === 'embed');
    }
    if (Array.isArray(node)) return node.some(scan);
    return false;
  };
  return scan(children);
}

function sourceCalloutTypeAt(markdown: string, offset?: number): string | null {
  if (offset === undefined) return null;
  const lineEnd = markdown.indexOf('\n', offset);
  const sourceLine = markdown.slice(offset, lineEnd === -1 ? markdown.length : lineEnd);
  const quote = sourceLine.match(/^ {0,3}>[ \t]?(.*)$/);
  if (!quote) return null;
  const match = quote[1].match(/^\[!(NOTE|TIP|WARNING|[A-Za-z][A-Za-z0-9_-]*)\]/i);
  return match?.[1].toUpperCase() ?? null;
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
  assets?: {
    universeId: string;
    shareToken?: string | null;
    /**
     * Phase 38 UAT-fix: pre-signed URL map from the API response.
     * Keys are asset UUIDs; values are signed /raw URLs that include ?e=&s= HMAC params
     * (or ?u=&e=&s= for share mode). When present, these are used directly as <img src>
     * instead of constructing the path — so <img> loads without Authorization: Bearer.
     */
    assetUrls?: Record<string, string>;
  };
}) {
  // Build the img component override only when `assets` prop is provided.
  const imgComponent = assets
    ? ({ src, alt }: { src?: string; alt?: string }) => {
        if (src?.startsWith('asset://')) {
          const uuid = src.slice('asset://'.length);
          // Phase 38 UAT-fix: prefer pre-signed URL from assetUrls map (server-provided,
          // includes HMAC sig so <img> can load without Authorization: Bearer header).
          // Fall back to constructing the URL if the map doesn't have this UUID.
          let rawUrl: string;
          if (assets.assetUrls?.[uuid]) {
            rawUrl = assets.assetUrls[uuid];
          } else if (assets.shareToken) {
            // Share mode fallback (Pitfall 4 / T-38-21): build share URL explicitly.
            rawUrl = `/api/share/assets/${uuid}/raw`;
          } else {
            // Authed fallback: bare URL (will 401 in browser without bearer — this path
            // should not be reached now that the API provides assetUrls, but kept as
            // belt-and-suspenders so the component degrades gracefully on old API responses).
            rawUrl = `/api/universes/${assets.universeId}/assets/${uuid}/raw`;
          }
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
    // ReactMarkdown keeps the callout marker inside the first paragraph. Keep a
    // source-level fallback as well so this display annotation remains stable
    // across ReactMarkdown child-shape changes.
    blockquote: ({ children, node }: { children?: React.ReactNode } & ExtraProps) => {
      const sourceType = sourceCalloutTypeAt(content, node?.position?.start.offset);
      const calloutType = sourceType && ['NOTE', 'TIP', 'WARNING'].includes(sourceType) ? sourceType : null;
      return (
        <blockquote
          data-callout-type={calloutType ?? undefined}
          className={calloutType ? 'markdown-callout' : undefined}
        >
          {children}
        </blockquote>
      );
    },
    ...(wikis
      ? {
          // Wrap p and li children in WikilinkText so [[word]] tokens are
          // tokenised in their text segments. Code spans are React elements
          // (not plain strings) inside these containers, so they pass through
          // WikilinkText unchanged — code-span exclusion holds.
          //
          // Phase 46 Plan 01: the whole `wikis` object is forwarded to WikilinkText
          // here — no structural change is needed. The new optional fields
          // (entriesById, embedDepth, currentEntryId) added in Plan 01 reach
          // WikilinkText automatically, enabling Plans 02 (EntryHoverCard) and
          // 03 (EntryEmbed) to consume them without re-touching this wiring.
          p: ({ children }: { children?: React.ReactNode }) =>
            // Phase 46 CR-01: a block-level embed callout cannot be a descendant
            // of <p> (React 19 reparents the DOM, breaking the embed layout).
            // When the paragraph contains a top-level embed, render a <div>
            // wrapper instead — a valid block container for the callout.
            paragraphHasBlockEmbed(children, wikis) ? (
              <div>
                <WikilinkText wikis={wikis}>{children}</WikilinkText>
              </div>
            ) : (
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
