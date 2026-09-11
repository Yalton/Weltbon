/**
 * api/src/services/rewrite-wikilinks.ts
 *
 * Pure server-side [[wikilink]] rewriter for Phase 48 rename-propagation (XREF-05).
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
// Constants
// ---------------------------------------------------------------------------

/**
 * Non-greedy, no-newline inner — identical to ingest-markdown.ts line 514 and
 * WikilinkText.tsx WIKILINK_RE but without the leading `(!?)` embed group that
 * WikilinkText needs for `![[embed]]` detection. The rewriter only touches [[ ]].
 */
export const WIKILINK_RE = /\[\[([^\]\n]+?)\]\]/g;

// ---------------------------------------------------------------------------
// codeRanges — the one code-exclusion dialect (T-48-01)
// ---------------------------------------------------------------------------

/**
 * Byte ranges of fenced code blocks and inline code spans in `body`, as
 * `[start, end)` pairs read from remark node offsets.
 *
 * Exported because every rewriter that splices into a body needs exactly this
 * and must not grow its own version: a regex approximation of "inside code"
 * disagrees with the parser on indented blocks, nested fences and `` `` ``
 * spans, and the disagreement shows up as a body silently rewritten inside an
 * example the author wrote to *show* the old spelling.
 */
export function codeRanges(body: string): Array<[number, number]> {
  const tree = unified().use(remarkParse).parse(body) as Root;
  const ranges: Array<[number, number]> = [];
  visit(tree, (node) => {
    if (node.type === 'code' || node.type === 'inlineCode') {
      const start = node.position?.start?.offset;
      const end = node.position?.end?.offset;
      if (start !== undefined && end !== undefined) {
        ranges.push([start, end]);
      }
      return 'skip';
    }
  });
  return ranges;
}

/** True when `offset` falls inside any `[start, end)` range. */
export function isInRange(offset: number, ranges: Array<[number, number]>): boolean {
  for (const [s, e] of ranges) {
    if (offset >= s && offset < e) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// parseWikilink — reproduces WikilinkText.parseWikilink exactly (D-07)
// ---------------------------------------------------------------------------

/**
 * Parse the inner content of a [[...]] token into a structured representation.
 *
 * Semantics are copied verbatim from `web/src/components/WikilinkText.tsx`
 * parseWikilink (lines 99-128) so the server rewriter and client tokenizer
 * never diverge (D-07).
 *
 * @param inner  The text inside `[[` … `]]` (the captured group, not the brackets).
 * @returns      target: the stripped ref (pipe-split, heading-stripped, .md-stripped, trimmed).
 *               label: explicit alias if present, else the stripped target.
 */
export function parseWikilink(inner: string): { target: string; label: string } {
  // a. Split on FIRST `|` for alias
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

  // e. Default label = stripped ref when no explicit alias
  const finalLabel = label !== undefined ? label : ref;

  return { target: ref, label: finalLabel };
}

// ---------------------------------------------------------------------------
// rewriteWikilinks
// ---------------------------------------------------------------------------

/**
 * Scan `body` for [[...]] wikilinks and rewrite any whose target matches a
 * stale name. Links inside fenced code blocks or inline code spans are NEVER
 * rewritten (D-07 hard constraint). Returns the rewritten body and the total
 * count of replacements made.
 *
 * @param body              The entry's full markdown body string.
 * @param staleNames        Set of lowercased names that no longer resolve (e.g. old
 *                          title or removed alias). Caller pre-lowercases all keys.
 * @param newCanonicalTitle The canonical title to rewrite stale targets to.
 */
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
  // Walk the AST for `code` (fenced) and `inlineCode` nodes; read
  // node.position.start.offset and node.position.end.offset to build an array
  // of [startByte, endByte) ranges in the original body string.
  //
  // Note: we do NOT use walkBodyExcludingCode from ingest-markdown here because
  // that visitor exposes text-node VALUES, not byte offsets, and cannot gate
  // positional splices. Sharing the remark PARSE (not the value-only visitor)
  // is what satisfies the "no third dialect" constraint.
  // ---------------------------------------------------------------------------
  const protectedRanges = codeRanges(body);

  // Helper: is a byte offset inside any protected range?
  function isProtected(offset: number): boolean {
    return isInRange(offset, protectedRanges);
  }

  // ---------------------------------------------------------------------------
  // Step 2: Positional match-and-rewrite over the full body string.
  //
  // Collect all wikilink matches (index + raw + inner) first, then process
  // them right-to-left so earlier byte offsets stay valid as we splice
  // replacements into the string.
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

    // Parse the token to extract the target ref.
    const parsed = parseWikilink(inner);

    // Case-insensitive key convention (D-07 / PATTERNS Shared Patterns).
    if (!staleNames.has(parsed.target.toLowerCase().trim())) continue;

    // Build the replacement preserving heading anchor and display label (D-03).
    // Reconstruct from STRUCTURED PARTS — never string-interpolate raw inner
    // (T-48-02: a title containing `]]` or `|` must not corrupt the output).
    const replacement = buildReplacement(inner, newCanonicalTitle);

    // Splice replacement into result at the correct position.
    result = result.slice(0, index) + replacement + result.slice(index + raw.length);
    count++;
  }

  return { body: result, count };
}

// ---------------------------------------------------------------------------
// Internal: build the rewritten [[...]] token from structured parts (T-48-02)
// ---------------------------------------------------------------------------

/**
 * Reconstruct a `[[...]]` token, swapping only the ref portion to
 * `newCanonicalTitle` while preserving any heading anchor and display label.
 *
 * Builds from structural parts rather than string-interpolating `inner` to
 * prevent a `|`-containing `newCanonicalTitle` from creating a spurious
 * second pipe segment (T-48-02).
 */
export function buildReplacement(inner: string, newCanonicalTitle: string): string {
  // a. Split on first `|` — if present, tail is the display label.
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

  // b. Extract heading anchor from refPart (comes after the first `#`).
  const hashIdx = refPart.indexOf('#');
  let anchorSuffix: string; // `#heading` to re-append, or empty string
  if (hashIdx !== -1) {
    anchorSuffix = refPart.slice(hashIdx); // includes the `#`
  } else {
    anchorSuffix = '';
  }

  // c. Assemble new inner: new canonical title + anchor + label.
  //    The .md suffix is not preserved (we matched after stripping it).
  const newInner = newCanonicalTitle + anchorSuffix + labelSuffix;

  return `[[${newInner}]]`;
}
