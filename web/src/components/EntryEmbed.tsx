import { Link } from 'react-router-dom';
import { useShareMode, useShareToken } from '../contexts/ShareModeContext';
import { useEntry } from '../hooks/useEntries';
import { MarkdownRenderer } from './MarkdownRenderer';
import type { WikilinkResolutionData } from './WikilinkText';

// ---------------------------------------------------------------------------
// EntryEmbed component
// ---------------------------------------------------------------------------

/**
 * Props for EntryEmbed.
 */
interface EntryEmbedProps {
  /**
   * The resolved entry id for the embed target.
   * Null when the caller could not resolve the target (D-10 unresolvable target).
   */
  targetId: string | null;
  /**
   * The display label from the ![[label]] token (used in affordance text).
   */
  label: string;
  /**
   * The route id of the entry currently being viewed (D-06 guard source).
   * Set by EntryDetail via wikis.currentEntryId (wired by Plan 46-01 — this
   * component only CONSUMES it, never defines it).
   * Optional — backward-compatible: undefined when caller predates 46-01.
   */
  currentEntryId: string | undefined;
  /**
   * Resolution data from the host MarkdownRenderer call.
   * Passed through to the recursive MarkdownRenderer for the embedded body,
   * with embedDepth: 1 merged in (D-05 flatten flag).
   */
  wikis: WikilinkResolutionData;
  /**
   * Universe id — used for share/auth URL construction and the useEntry call.
   */
  universeId: string;
}

// ---------------------------------------------------------------------------
// Non-fatal affordance components
// ---------------------------------------------------------------------------

/**
 * D-06: Circular/self-embed affordance — a muted linked notice.
 * The entry link is still rendered so the reader can navigate to the entry.
 */
function CircularEmbedNotice({
  label,
  entryTo,
}: {
  label: string;
  entryTo: string;
}) {
  return (
    <span
      data-testid="embed-circular-notice"
      className="inline-flex items-center gap-1 text-neutral-500 dark:text-neutral-400 bg-neutral-100 dark:bg-neutral-800/40 border border-neutral-300 dark:border-neutral-700 rounded px-1.5 py-0.5 text-sm"
      aria-label={`circular embed — ${label}`}
    >
      circular embed —{' '}
      <Link to={entryTo} className="underline hover:text-neutral-700 dark:hover:text-neutral-200">
        {label}
      </Link>
    </span>
  );
}

/**
 * D-10: Unavailable/missing embed affordance — non-fatal, always renders.
 * Used when targetId is null (unresolved in wikilink maps) or when the
 * fetch returns a 404/error (private entry in share mode, or deleted entry).
 */
function UnavailableEmbedNotice({
  label,
  entryTo,
}: {
  label: string;
  entryTo: string | null;
}) {
  const inner = (
    <span
      data-testid="embed-unavailable"
      className="inline-flex items-center gap-1 text-amber-700 dark:text-amber-400 bg-amber-50 dark:bg-amber-950/30 border border-amber-300 dark:border-amber-800 rounded px-1.5 py-0.5 text-sm"
      aria-label={`embed unavailable — ${label}`}
    >
      embed unavailable —{' '}
      {entryTo ? (
        <Link
          to={entryTo}
          className="underline hover:text-amber-900 dark:hover:text-amber-200"
        >
          {label}
        </Link>
      ) : (
        <span>{label}</span>
      )}
    </span>
  );
  return inner;
}

// ---------------------------------------------------------------------------
// EntryEmbed
// ---------------------------------------------------------------------------

/**
 * Phase 46 Plan 03 — XREF-03 `![[entry]]` inline transclusion block.
 *
 * Renders a target entry's body inline as a bordered callout with an
 * attribution header link. Non-fatal affordances for self-embed (D-06)
 * and unresolved/private targets (D-10). Depth-1 flatten: the recursive
 * MarkdownRenderer call receives `embedDepth: 1` so any `![[...]]` inside
 * the embedded body renders as a normal hover-card link, not another embed (D-05).
 *
 * Security:
 *   T-46-08 (XSS): body renders ONLY through MarkdownRenderer (react-markdown sanitization) — XSS-safe.
 *   T-46-09 (private entry): fetch uses useEntry → share seam; 404 on is_public=false → D-10 affordance.
 *   T-46-10 (render loop): D-05 flatten (embedDepth:1) + D-06 self/circular guard.
 *   T-46-11 (404/missing): D-10 non-fatal affordance.
 */
export function EntryEmbed({
  targetId,
  label,
  currentEntryId,
  wikis,
  universeId,
}: EntryEmbedProps) {
  const isShareMode = useShareMode();
  const shareToken = useShareToken();

  // ---------------------------------------------------------------------------
  // D-06 self/circular guard — check BEFORE the hook call so we can pass ''
  // to disable the fetch for the self case. React hook rules: hook MUST be
  // called unconditionally, so we pass '' to leverage the enabled gate inside.
  // ---------------------------------------------------------------------------
  const isSelf = !!targetId && targetId === currentEntryId;

  // Gate: pass '' for self-embed or null target so useEntry's
  // `enabled: !!universeId && !!entryId` guard disables the fetch.
  // Honors the existing ['entry', universeId, entryId] key — no re-key.
  const fetchId = isSelf || !targetId ? '' : targetId;

  // UNCONDITIONAL hook call (React hook rules).
  const { data: entryData, isLoading, isError } = useEntry(universeId, fetchId);

  // ---------------------------------------------------------------------------
  // Build entryTo (share/auth branch) — mirrors WikilinkText:185-188
  // ---------------------------------------------------------------------------
  const entryTo =
    targetId
      ? isShareMode && shareToken
        ? `/share/${shareToken}/entries/${targetId}`
        : `/universes/${universeId}/entries/${targetId}`
      : null;

  // ---------------------------------------------------------------------------
  // Render branch 1: null target — D-10 unavailable (target unresolvable)
  // ---------------------------------------------------------------------------
  if (!targetId) {
    return <UnavailableEmbedNotice label={label} entryTo={null} />;
  }

  // ---------------------------------------------------------------------------
  // Render branch 2: self/circular — D-06 circular-embed affordance
  // (do NOT render callout or body even if stale data in cache)
  // ---------------------------------------------------------------------------
  if (isSelf) {
    return <CircularEmbedNotice label={label} entryTo={entryTo!} />;
  }

  // ---------------------------------------------------------------------------
  // Render branch 3: resolved target — loading / data / error
  // ---------------------------------------------------------------------------

  // Loading state: minimal placeholder
  if (isLoading) {
    return (
      <span className="inline-block border border-neutral-200 dark:border-neutral-700 rounded px-2 py-1 text-sm text-neutral-400 dark:text-neutral-500 italic">
        Loading embed…
      </span>
    );
  }

  // Fetch error or missing body (404 / private entry in share mode) → D-10
  if (isError || !entryData?.body) {
    return <UnavailableEmbedNotice label={label} entryTo={entryTo} />;
  }

  // ---------------------------------------------------------------------------
  // Resolved body: D-07 bordered callout + D-08 attribution + D-09 full body
  // ---------------------------------------------------------------------------
  return (
    <div
      data-testid="embed-callout"
      className="my-4 border-l-4 border-[color:var(--color-accent)] bg-neutral-50 dark:bg-neutral-800/40 rounded-r-md overflow-hidden"
    >
      {/* D-08 Attribution header: icon + title + nav glyph, as a link to the target */}
      <div className="px-4 pt-3 pb-2 border-b border-neutral-200 dark:border-neutral-700">
        <Link
          data-testid="embed-attribution-link"
          to={entryTo!}
          className="inline-flex items-center gap-1.5 text-sm font-semibold text-[color:var(--color-accent)] hover:underline"
        >
          {entryData.icon && (
            <span className="text-base leading-none">{entryData.icon}</span>
          )}
          {entryData.title ?? label}
          <span aria-hidden="true">↗</span>
        </Link>
      </div>

      {/* D-09 Full embedded body via MarkdownRenderer (D-05 flatten: embedDepth:1).
          T-46-08: body renders through MarkdownRenderer's sanitized react-markdown
          path — XSS-safe, identical to the host entry body render path. */}
      <div className="px-4 py-3">
        <MarkdownRenderer
          content={entryData.body}
          wikis={{ ...wikis, embedDepth: 1 }}
          assets={{
            universeId,
            shareToken: shareToken ?? null,
            assetUrls: entryData.assetUrls,
          }}
        />
      </div>
    </div>
  );
}
