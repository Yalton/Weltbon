import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { WikilinkText } from './WikilinkText';
import type { WikilinkResolutionData } from './WikilinkText';

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
 * T-32-12 XSS: react-markdown sanitises by default; WikilinkText renders
 * tokens as React elements only (no dangerouslySetInnerHTML).
 * T-32-13: resolution data arrives via props (not fetched inside this
 * component or WikilinkText — Pitfall 3 prevention).
 */
export function MarkdownRenderer({
  content,
  wikis,
}: {
  content: string;
  wikis?: WikilinkResolutionData;
}) {
  const components = wikis
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
    : undefined;

  return (
    <div className="prose prose-neutral dark:prose-invert max-w-none">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {content}
      </ReactMarkdown>
    </div>
  );
}
