import { Fragment } from 'react';
import { Link } from 'react-router-dom';
import type { DictionaryWord } from '../hooks/useDictionary';
import type { Entry } from '../hooks/useEntries';
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
  /**
   * Phase 46 Plan 01 (D-11/D-12/D-13 hover-card content source).
   * Full entry objects keyed by id, built from the already-cached useEntries list.
   * Optional — backward-compatible like entryAliases above.
   * Consumed by Plan 02 (EntryHoverCard) and Plan 03 (EntryEmbed).
   */
  entriesById?: Map<string, Entry>;
  /**
   * Phase 46 Plan 01 (D-05 flatten control).
   * The nesting depth of the current render context.
   * undefined / 0 = top level (embeds expand); 1 = inside an embedded body
   * (embed segments flatten to wikilink rendering — cycle-safe depth-1 flatten).
   * Optional — backward-compatible. Set by Plan 03's EntryEmbed recursive call.
   */
  embedDepth?: number;
  /**
   * Phase 46 Plan 01 (D-06 self/circular-embed guard source).
   * The route id of the entry currently being viewed, set by EntryDetail (Task 2).
   * Consumed by Plan 03's EntryEmbed component to detect and render the circular-embed
   * affordance instead of expanding. Never rendered itself — only compared by equality.
   * Optional — backward-compatible.
   */
  currentEntryId?: string;
}

// ---------------------------------------------------------------------------
// Regex + parse helpers (copied verbatim from api/src/services/ingest-markdown.ts
// scanWikilinks, lines 514-553 — parity with server-side token parse).
// ---------------------------------------------------------------------------

// T-32-SC (Tampering) — no new deps; T-32-12 (XSS) — tokens are React
// elements (text + spans), never dangerouslySetInnerHTML.
// Phase 46 Plan 01: group 1 = optional leading `!` (embed marker),
// group 2 = inner ref. A bare `!` not immediately followed by `[[` stays
// plain text — the regex requires `!` to be adjacent to `[[` to capture it.
const WIKILINK_RE = /(!?)\[\[([^\]\n]+?)\]\]/g;

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
  | { kind: 'wikilink'; inner: string; raw: string }
  /**
   * Phase 46 Plan 01 (D-05 / XREF-03): embed transclusion token.
   * Emitted when a `!` immediately precedes `[[...]]`. The inner ref is
   * identical in shape to a wikilink inner — parseWikilink handles it the
   * same way. Plan 03's EntryEmbed component owns the render branch for this
   * kind; at this plan's stage an embed segment falls through to the existing
   * wikilink handling (renders as a normal link — non-throwing interim behavior).
   */
  | { kind: 'embed'; inner: string; raw: string };

/**
 * Split a plain-text string into Segment tokens.
 * Exported for unit testing (Phase 46 Plan 01).
 */
export function tokenize(text: string): Segment[] {
  const segments: Segment[] = [];
  WIKILINK_RE.lastIndex = 0;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = WIKILINK_RE.exec(text)) !== null) {
    const bang = match[1];   // group 1: '' or '!'
    const inner = match[2];  // group 2: the inner ref text
    // When there is a leading `!`, the match begins one character earlier
    // (at the `!`), but match.index points to `!` only if it's the start
    // of the full match. We need to account for the `!` in the leading text.
    const matchStart = match.index;
    if (matchStart > lastIndex) {
      segments.push({ kind: 'text', text: text.slice(lastIndex, matchStart) });
    }
    if (bang === '!') {
      segments.push({ kind: 'embed', inner, raw: match[0] });
    } else {
      segments.push({ kind: 'wikilink', inner, raw: match[0] });
    }
    lastIndex = matchStart + match[0].length;
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
          // wikilink segment OR embed segment.
          // Phase 46 Plan 01: embed segments fall through to the existing
          // wikilink resolution path here. Plan 03 (EntryEmbed) will add the
          // proper embed render branch in a later extension of resolveSegment.
          // This interim behavior renders embeds as normal entry links, which
          // is non-throwing and acceptable until Plan 03 is in place.
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
