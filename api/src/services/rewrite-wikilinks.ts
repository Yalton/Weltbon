/**
 * api/src/services/rewrite-wikilinks.ts
 *
 *
 * Decisions implemented:
 *   D-01  Rewrite only link forms whose target would otherwise stop resolving.
 *   D-02  Bare [[Target]] follows rename — visible text updates to the new title.
 *   D-03  [[Target|display]] rewrites only the target, leaves display text byte-identical.
 *   D-04  Dropped-alias links rewrite to the new canonical title.
 *   D-05  Surviving-alias links left untouched (staleNames does not contain them).
 *   D-07  Case-insensitive (staleNames keys are lowercased); heading anchors preserved;
 *          trailing .md stripped before matching; code-span exclusion via SAME remark
 *          parse that ingest-markdown uses (NO third code-exclusion dialect).
 *
 * Security:
 *   T-48-01  Code spans excluded via protected byte ranges from remark node.position
 *             offsets — not a heuristic regex, not a third dialect.
 *   T-48-02  newCanonicalTitle is inserted only inside [[ ]] brackets; rebuild from
 *             structured parts rather than string-interpolating the raw inner value.
 *   T-48-03  WIKILINK_RE uses the non-greedy, no-newline, ]-bounded form
 *             `[^\]\n]+?` — safe from catastrophic backtracking (T-11-02b precedent).
 *   T-48-SC  No new packages — reuses existing unified/remark-parse/unist-util-visit.
 */

import { unified } from 'unified';
import remarkParse from 'remark-parse';
import { visit } from 'unist-util-visit';
import type { Root } from 'mdast';

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------

const WIKILINK_RE = /\[\[([^\]\n]+?)\]\]/g;

// ---------------------------------------------------------------------------
// parseWikilink — reproduces WikilinkText.parseWikilink exactly (D-07)
// ---------------------------------------------------------------------------

export function parseWikilink(inner: string): { target: string; label: string } {
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

export function rewriteWikilinks(
  body: string,
  staleNames: Set<string>,
  newCanonicalTitle: string,
): { body: string; count: number } {
  if (staleNames.size === 0) {
    return { body, count: 0 };
  }

  // ---------------------------------------------------------------------------
  // Step 1: Compute protected byte ranges from the shared remark parse (D-07 /
  // T-48-01). Parse body with the SAME unified().use(remarkParse) the
  // ingest-markdown service uses so there is no third code-exclusion dialect.
  // Note: we do NOT use walkBodyExcludingCode from ingest-markdown here because
  // that visitor exposes text-node VALUES, not byte offsets, and cannot gate
  // positional splices. Sharing the remark PARSE (not the value-only visitor)
  // ---------------------------------------------------------------------------
  const tree = unified().use(remarkParse).parse(body) as Root;

  const protectedRanges: [number, number][] = [];

  visit(tree, (node) => {
    if (node.type === 'code' || node.type === 'inlineCode') {
      const start = node.position?.start?.offset;
      const end = node.position?.end?.offset;
      if (start !== undefined && end !== undefined) {
        protectedRanges.push([start, end]);
      }
      return 'skip';
    }
  });

  function isProtected(offset: number): boolean {
    for (const [s, e] of protectedRanges) {
      if (offset >= s && offset < e) return true;
    }
    return false;
  }

  // ---------------------------------------------------------------------------
  // Step 2: Positional match-and-rewrite over the full body string.
  // them right-to-left so earlier byte offsets stay valid as we splice
  // ---------------------------------------------------------------------------

  interface Match {
    index: number;   // byte offset of `[[` in body
    raw: string;     // full match including `[[...]]`
    inner: string;   // captured group 1 (the content inside brackets)
  }

  const matches: Match[] = [];
  WIKILINK_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = WIKILINK_RE.exec(body)) !== null) {
    matches.push({ index: m.index, raw: m[0], inner: m[1] });
  }

  if (matches.length === 0) {
    return { body, count: 0 };
  }

  // Process right-to-left so splices don't shift earlier indices.
  let result = body;
  let count = 0;

  for (let i = matches.length - 1; i >= 0; i--) {
    const { index, raw, inner } = matches[i];

    // Skip links inside protected code ranges (T-48-01).
    if (isProtected(index)) continue;

    const parsed = parseWikilink(inner);

    // Case-insensitive key convention (D-07 / PATTERNS Shared Patterns).
    if (!staleNames.has(parsed.target.toLowerCase().trim())) continue;

    // Build the replacement preserving heading anchor and display label (D-03).
    // Reconstruct from STRUCTURED PARTS — never string-interpolate raw inner
    // (T-48-02: a title containing `]]` or `|` must not corrupt the output).
    const replacement = buildReplacement(inner, newCanonicalTitle);

    result = result.slice(0, index) + replacement + result.slice(index + raw.length);
    count++;
  }

  return { body: result, count };
}

// ---------------------------------------------------------------------------
// Internal: build the rewritten [[...]] token from structured parts (T-48-02)
// ---------------------------------------------------------------------------

function buildReplacement(inner: string, newCanonicalTitle: string): string {
  const pipeIdx = inner.indexOf('|');
  let refPart: string;       // everything before the first pipe (or all of inner)
  let labelSuffix: string;   // `|display` suffix to preserve, or empty string

  if (pipeIdx !== -1) {
    refPart = inner.slice(0, pipeIdx);
    labelSuffix = inner.slice(pipeIdx); // includes the `|`
  } else {
    refPart = inner;
    labelSuffix = '';
  }

  const hashIdx = refPart.indexOf('#');
  let anchorSuffix: string; // `#heading` to re-append, or empty string
  if (hashIdx !== -1) {
    anchorSuffix = refPart.slice(hashIdx); // includes the `#`
  } else {
    anchorSuffix = '';
  }

  const newInner = newCanonicalTitle + anchorSuffix + labelSuffix;

  return `[[${newInner}]]`;
}
