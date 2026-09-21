import { Fragment } from 'react';
import { Link } from 'react-router-dom';
import type { DictionaryWord } from '../hooks/useDictionary';
import type { Entry } from '../hooks/useEntries';
import { WordPopover } from './WordPopover';
import { EntryHoverCard } from './EntryHoverCard';
import { EntryEmbed } from './EntryEmbed';

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------

export interface WikilinkResolutionData {
  entryTitles: Map<string, string>;
  entryAliases?: Map<string, string>;
  dictionaryWords: Map<string, DictionaryWord>;
  universeId: string;
  languageEntryId?: string | null;
  onAddWord?: (token: string) => void;
  isShareMode?: boolean;
  shareToken?: string | null;
  entriesById?: Map<string, Entry>;
  embedDepth?: number;
  currentEntryId?: string;
}

// ---------------------------------------------------------------------------
// Regex + parse helpers (copied verbatim from api/src/services/ingest-markdown.ts
// scanWikilinks, lines 514-553 — parity with server-side token parse).
// ---------------------------------------------------------------------------

// T-32-SC (Tampering) — no new deps; T-32-12 (XSS) — tokens are React
const WIKILINK_RE = /(!?)\[\[([^\]\n]+?)\]\]/g;

interface ParsedToken {
  target: string;
  label: string;
}

function parseWikilink(inner: string): ParsedToken {
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

  const hashIdx = ref.indexOf('#');
  if (hashIdx !== -1) {
    ref = ref.slice(0, hashIdx);
  }

  // c. Strip trailing `.md` (case-insensitive)
  ref = ref.replace(/\.md$/i, '');

  ref = ref.trim();

  const finalLabel = label !== undefined ? label : ref;

  return { target: ref, label: finalLabel };
}

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------

type Segment =
  | { kind: 'text'; text: string }
  | { kind: 'wikilink'; inner: string; raw: string }
  | { kind: 'embed'; inner: string; raw: string };

export function tokenize(text: string): Segment[] {
  const segments: Segment[] = [];
  WIKILINK_RE.lastIndex = 0;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = WIKILINK_RE.exec(text)) !== null) {
    const bang = match[1];   // group 1: '' or '!'
    const inner = match[2];  // group 2: the inner ref text
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
// ---------------------------------------------------------------------------

interface WikilinkTextProps {
  children: React.ReactNode;
  wikis: WikilinkResolutionData;
}

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
    entriesById,
    embedDepth,
  } = wikis;

  function resolveSegment(inner: string, label: string, raw: string, key: string) {
    const { target } = parseWikilink(inner);

    if (target.length === 0) {
      return <Fragment key={key}>{raw}</Fragment>;
    }

    const lowerTarget = target.toLowerCase().trim();

    // D-01: entry-title FIRST (case-insensitive — D-03 aligns render with ingest).
    if (entryTitles.has(lowerTarget)) {
      const entryId = entryTitles.get(lowerTarget)!;
      const entryTo =
        isShareMode && shareToken
          ? `/share/${shareToken}/entries/${entryId}`
          : `/universes/${universeId}/entries/${entryId}`;
      const link = (
        <Link
          key={key}
          to={entryTo}
          className="text-sm text-[color:var(--color-accent)] hover:underline"
        >
          {label}
        </Link>
      );
      // so hovering shows the preview card (D-01..D-04, D-11..D-13).
      // Graceful degradation: if entriesById is undefined (caller predating 46-01)
      const entryObj = entriesById?.get(entryId);
      if (entryObj) {
        return (
          <EntryHoverCard key={key} entry={entryObj} universeId={universeId}>
            {link}
          </EntryHoverCard>
        );
      }
      return link;
    }

    if (entryAliases?.has(lowerTarget)) {
      const entryId = entryAliases.get(lowerTarget)!;
      const entryTo =
        isShareMode && shareToken
          ? `/share/${shareToken}/entries/${entryId}`
          : `/universes/${universeId}/entries/${entryId}`;
      const link = (
        <Link
          key={key}
          to={entryTo}
          className="text-sm text-[color:var(--color-accent)] hover:underline"
        >
          {label}
        </Link>
      );
      const entryObj = entriesById?.get(entryId);
      if (entryObj) {
        return (
          <EntryHoverCard key={key} entry={entryObj} universeId={universeId}>
            {link}
          </EntryHoverCard>
        );
      }
      return link;
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
      return node;
    }

    const segments = tokenize(node);
    if (segments.length === 0) return node;
    if (segments.length === 1 && segments[0].kind === 'text') return node;

    return (
      <Fragment key={nodeKey}>
        {segments.map((seg, i) => {
          const key = `${nodeKey}-${i}`;
          if (seg.kind === 'text') {
            return <Fragment key={key}>{seg.text}</Fragment>;
          }
          if (seg.kind === 'embed') {
            const parsed = parseWikilink(seg.inner);
            const lowerTarget = parsed.target.toLowerCase().trim();

            // D-05 flatten: when already inside an embedded body (embedDepth === 1),
            // render the ![[...]] as a normal wikilink/hover-card link — NOT a recursive
            // embed. This is the cycle-safe depth-1 flatten decision.
            if (embedDepth === 1) {
              // Fall through to existing wikilink resolution (renders as a link/hover-card).
              return resolveSegment(seg.inner, parsed.label, seg.raw, key);
            }

            // Top-level embed (embedDepth undefined/0): resolve target id via the same
            const resolvedId =
              entryTitles.get(lowerTarget) ??
              entryAliases?.get(lowerTarget) ??
              null;

            return (
              <EntryEmbed
                key={key}
                targetId={resolvedId}
                label={parsed.label}
                currentEntryId={wikis.currentEntryId}
                wikis={wikis}
                universeId={universeId}
              />
            );
          }

          const parsed = parseWikilink(seg.inner);
          return resolveSegment(seg.inner, parsed.label, seg.raw, key);
        })}
      </Fragment>
    );
  }

  const processed = Array.isArray(children)
    ? children.map((child, i) => processNode(child, `wt-${i}`))
    : processNode(children, 'wt-0');

  return <>{processed}</>;
}
