import ReactMarkdown, { defaultUrlTransform, type ExtraProps } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import React from 'react';
import { WikilinkText, tokenize } from './WikilinkText';
import type { WikilinkResolutionData } from './WikilinkText';
import { stripMarkdownFrontmatter } from '../lib/markdownAuthoring';

function urlTransformWithAssets(url: string): string {
  if (url.startsWith('asset://')) return url;
  return defaultUrlTransform(url);
}

function paragraphHasBlockEmbed(
  children: React.ReactNode,
  wikis: WikilinkResolutionData,
): boolean {
  if (wikis.embedDepth === 1) return false;
  const scan = (node: React.ReactNode): boolean => {
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

function stripCalloutMarker(
  children: React.ReactNode,
  calloutType: string,
): React.ReactNode {
  const marker = new RegExp(`^\\[!${calloutType}\\]`, 'i');
  let removed = false;

  const visit = (node: React.ReactNode): React.ReactNode => {
    if (removed) return node;
    if (typeof node === 'string') {
      const match = marker.exec(node);
      if (!match) return node;
      removed = true;
      return node.slice(match[0].length).replace(/^[ \t]+/, '');
    }
    if (Array.isArray(node)) return node.map(visit);
    if (React.isValidElement(node)) {
      const props = node.props as { children?: React.ReactNode };
      if (!('children' in props)) return node;
      return React.cloneElement(node, undefined, visit(props.children));
    }
    return node;
  };

  return visit(children);
}

// Re-export so callers can import the type from the MarkdownRenderer module.
export type { WikilinkResolutionData };

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
     * Keys are asset UUIDs; values are signed /raw URLs that include ?e=&s= HMAC params
     * (or ?u=&e=&s= for share mode). When present, these are used directly as <img src>
     * instead of constructing the path — so <img> loads without Authorization: Bearer.
     */
    assetUrls?: Record<string, string>;
  };
}) {
  const renderedContent = stripMarkdownFrontmatter(content);

  const imgComponent = assets
    ? ({ src, alt }: { src?: string; alt?: string }) => {
        if (src?.startsWith('asset://')) {
          const uuid = src.slice('asset://'.length);
          // includes HMAC sig so <img> can load without Authorization: Bearer header).
          let rawUrl: string;
          if (assets.assetUrls?.[uuid]) {
            rawUrl = assets.assetUrls[uuid];
          } else if (assets.shareToken) {
            // Share mode fallback (Pitfall 4 / T-38-21): build share URL explicitly.
            rawUrl = `/api/share/assets/${uuid}/raw`;
          } else {
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
    // source-level fallback as well so this display annotation remains stable
    // across ReactMarkdown child-shape changes.
    blockquote: ({ children, node }: { children?: React.ReactNode } & ExtraProps) => {
      const sourceType = sourceCalloutTypeAt(renderedContent, node?.position?.start.offset);
      const calloutType = sourceType && ['NOTE', 'TIP', 'WARNING', 'IMPORTANT'].includes(sourceType)
        ? sourceType
        : null;
      return (
        <blockquote
          data-callout-type={calloutType ?? undefined}
          className={calloutType ? 'markdown-callout' : undefined}
        >
          {calloutType ? stripCalloutMarker(children, calloutType) : children}
        </blockquote>
      );
    },
    ...(wikis
      ? {
          // WikilinkText unchanged — code-span exclusion holds.

          // 03 (EntryEmbed) to consume them without re-touching this wiring.
          p: ({ children }: { children?: React.ReactNode }) =>
            // When the paragraph contains a top-level embed, render a <div>
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


  const resolvedComponents =
    Object.keys(components).length > 0 ? components : undefined;

  return (
    <div className="prose prose-neutral dark:prose-invert max-w-none">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={resolvedComponents}
        // URL transform (security-preserving; blocks javascript: etc.).
        urlTransform={assets ? urlTransformWithAssets : defaultUrlTransform}
      >
        {renderedContent}
      </ReactMarkdown>
    </div>
  );
}
