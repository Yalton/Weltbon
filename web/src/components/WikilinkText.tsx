import { Fragment } from 'react';
import { Link } from 'react-router-dom';
import type { DictionaryWord } from '../hooks/useDictionary';
import { WordPopover } from './WordPopover';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Resolution data passed from the parent (never fetched inside this
 * component — T-32-13 Pitfall 3 prevention).
 */
export interface WikilinkResolutionData {
  /**
   * Normalized entry title → entry id.
   * Phase 45 D-03: build with `title.trim().toLowerCase()` as key so that
   * [[empire]] resolves to "Empire". D-04 oldest-created_at wins on collision.
   */
  entryTitles: Map<string, string>;
  /**
   * Phase 45 XREF-04 (D-01/D-03): lower(alias) → entry id.
   * Slot 2 in resolution order: title (case-insensitive) → alias → dictionary.
   * Optional so un-updated callers degrade gracefully (alias tier skipped, no crash).
   * Constructed by the caller (EntryDetail) from entry.aliases.
   */
  entryAliases?: Map<string, string>;
  /** lower(word) → DictionaryWord row. */
  dictionaryWords: Map<string, DictionaryWord>;
  universeId: string;
  /** Non-null when the entry links a specific language dictionary (D-02). */
  languageEntryId?: string | null;
  /**
   * Callback invoked when the user clicks the "+" add button on an
   * unresolved `[[word]]` span. When absent (share / read-only path),
   * the "+" button is not rendered (T-32-11).
   */
  onAddWord?: (token: string) => void;
  /**
   * Phase 33 INT-BLOCKER-2 fix: when true, entry-title wikilinks generate a
   * `/share/${shareToken}/entries/${entryId}` target instead of the
   * authenticated `/universes/${universeId}/entries/${entryId}` path.
   * Absent (undefined) is treated as false — backward-compatible, matching
   * the existing optional `onAddWord` convention.
   */
  isShareMode?: boolean;
  /**
   * The share token for building share-subtree navigation targets.
   * Required when `isShareMode` is true; ignored otherwise.
   */
  shareToken?: string | null;
}

// ---------------------------------------------------------------------------
// Regex + parse helpers (copied verbatim from api/src/services/ingest-markdown.ts
// scanWikilinks, lines 514-553 — parity with server-side token parse).
// ---------------------------------------------------------------------------

// T-32-SC (Tampering) — no new deps; T-32-12 (XSS) — tokens are React
// elements (text + spans), never dangerouslySetInnerHTML.
const WIKILINK_RE = /\[\[([^\]\n]+?)\]\]/g;

interface ParsedToken {
  /** The target reference (pipe-split, heading-stripped, .md-stripped). */
  target: string;
  /** Display label: alias if given, else the stripped target. */
  label: string;
}

function parseWikilink(inner: string): ParsedToken {
  // a. Split on first `|` for alias
  const pipeIdx = inner.indexOf('|');
  let ref: string;
  let label: string | undefined;
  if (pipeIdx !== -1) {
    ref = inner.slice(0, pipeIdx);
    label = inner.slice(pipeIdx + 1);
  } else {
    ref = inner;
    label = undefined;
  }

  // b. Strip heading anchor: split on first `#`
  const hashIdx = ref.indexOf('#');
  if (hashIdx !== -1) {
    ref = ref.slice(0, hashIdx);
  }

  // c. Strip trailing `.md` (case-insensitive)
  ref = ref.replace(/\.md$/i, '');

  // d. Trim ref
  ref = ref.trim();

  // e. Default label = ref if no explicit alias
  const finalLabel = label !== undefined ? label : ref;

  return { target: ref, label: finalLabel };
}

// ---------------------------------------------------------------------------
// Text segment tokenizer
// ---------------------------------------------------------------------------

type Segment =
  | { kind: 'text'; text: string }
  | { kind: 'wikilink'; inner: string; raw: string };

function tokenize(text: string): Segment[] {
  const segments: Segment[] = [];
  WIKILINK_RE.lastIndex = 0;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = WIKILINK_RE.exec(text)) !== null) {
    if (match.index > lastIndex) {
      segments.push({ kind: 'text', text: text.slice(lastIndex, match.index) });
    }
    segments.push({ kind: 'wikilink', inner: match[1], raw: match[0] });
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < text.length) {
    segments.push({ kind: 'text', text: text.slice(lastIndex) });
  }
  return segments;
}

// ---------------------------------------------------------------------------
// WikilinkText component
// ---------------------------------------------------------------------------

interface WikilinkTextProps {
  /**
   * Children from ReactMarkdown (mixed string and React nodes).
   * Only string segments are scanned for `[[...]]` tokens; other node
   * types (JSX, null, etc.) pass through unchanged — this ensures code
   * spans (`code`/`pre`, which ReactMarkdown renders as non-string nodes)
   * are never resolved.
   */
  children: React.ReactNode;
  wikis: WikilinkResolutionData;
}

/**
 * Phase 32 Plan 04 — D-01/D-02/D-03/D-04 `[[word]]` render-time resolution.
 *
 * Walk `children` from ReactMarkdown. For string segments, split on the
 * wikilink regex. For each token, resolve in D-01 order:
 *   1. entryTitles → entry link (D-01, title beats dict even on same spelling)
 *   2. dictionaryWords → WordPopover (D-04)
 *   3. else → amber unresolved span (D-03) + "+" add button if onAddWord given
 *
 * Non-string / non-matching segments pass through unchanged.
 * Inline code (`code`) nodes arrive as non-string React elements and are
 * never scanned — code-span exclusion holds automatically.
 */
export function WikilinkText({ children, wikis }: WikilinkTextProps) {
  const {
    entryTitles,
    entryAliases,
    dictionaryWords,
    universeId,
    languageEntryId,
    onAddWord,
    isShareMode,
    shareToken,
  } = wikis;

  function resolveSegment(inner: string, label: string, raw: string, key: string) {
    const { target } = parseWikilink(inner);

    if (target.length === 0) {
      return <Fragment key={key}>{raw}</Fragment>;
    }

    // Phase 45 D-03: compute lowerTarget ONCE for all case-insensitive lookups.
    const lowerTarget = target.toLowerCase().trim();

    // D-01: entry-title FIRST (case-insensitive — D-03 aligns render with ingest).
    // Callers build entryTitles with lower(title.trim()) keys from Phase 45 onward.
    if (entryTitles.has(lowerTarget)) {
      const entryId = entryTitles.get(lowerTarget)!;
      // Phase 33 INT-BLOCKER-2 fix: in share mode, navigate within the share
      // subtree to keep visitors out of the ProtectedRoute tree. When
      // isShareMode is false/absent, use the authenticated path (default).
      const entryTo =
        isShareMode && shareToken
          ? `/share/${shareToken}/entries/${entryId}`
          : `/universes/${universeId}/entries/${entryId}`;
      return (
        <Link
          key={key}
          to={entryTo}
          className="text-sm text-[color:var(--color-accent)] hover:underline"
        >
          {label}
        </Link>
      );
    }

    // Phase 45 XREF-04 (D-01 slot 2): alias tier — case-insensitive, after title, before dictionary.
    if (entryAliases?.has(lowerTarget)) {
      const entryId = entryAliases.get(lowerTarget)!;
      const entryTo =
        isShareMode && shareToken
          ? `/share/${shareToken}/entries/${entryId}`
          : `/universes/${universeId}/entries/${entryId}`;
      return (
        <Link
          key={key}
          to={entryTo}
          className="text-sm text-[color:var(--color-accent)] hover:underline"
        >
          {label}
        </Link>
      );
    }

    // D-02: dictionary word (case-insensitive) — lowerTarget already computed above.
    if (dictionaryWords.has(lowerTarget)) {
      const wordRow = dictionaryWords.get(lowerTarget)!;
      return (
        <WordPopover
          key={key}
          word={wordRow.word}
          displayLabel={label}
          gloss={wordRow.gloss}
          ipa={wordRow.ipa}
          universeId={universeId}
          languageEntryId={languageEntryId}
        />
      );
    }

    // D-03: unresolved — amber missing affordance
    return (
      <span
        key={key}
        className="inline-flex items-center gap-0.5 text-amber-700 dark:text-amber-400 bg-amber-50 dark:bg-amber-950/30 border border-amber-300 dark:border-amber-800 rounded px-1"
        aria-label={`${target} — not found in dictionary`}
      >
        {label}
        {onAddWord && (
          <button
            type="button"
            onClick={() => onAddWord(target)}
            aria-label={`Add ${target} to dictionary`}
            className="ml-0.5 text-[color:var(--color-accent)] hover:opacity-80 focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--color-accent)]"
          >
            +
          </button>
        )}
      </span>
    );
  }

  function processNode(node: React.ReactNode, nodeKey: string): React.ReactNode {
    if (typeof node !== 'string') {
      // Non-string nodes (React elements, null, undefined, booleans, numbers)
      // pass through unchanged. This is the code-span exclusion: ReactMarkdown
      // renders `code` spans as React elements, not plain strings.
      return node;
    }

    const segments = tokenize(node);
    if (segments.length === 0) return node;
    // If the entire string is just plain text (no wikilinks), return it unchanged.
    if (segments.length === 1 && segments[0].kind === 'text') return node;

    return (
      <Fragment key={nodeKey}>
        {segments.map((seg, i) => {
          const key = `${nodeKey}-${i}`;
          if (seg.kind === 'text') {
            return <Fragment key={key}>{seg.text}</Fragment>;
          }
          // wikilink segment
          const parsed = parseWikilink(seg.inner);
          return resolveSegment(seg.inner, parsed.label, seg.raw, key);
        })}
      </Fragment>
    );
  }

  // Recursively walk React children; resolve wikilinks in string nodes only.
  const processed = Array.isArray(children)
    ? children.map((child, i) => processNode(child, `wt-${i}`))
    : processNode(children, 'wt-0');

  return <>{processed}</>;
}
