import { Link } from 'react-router-dom';
import { useShareMode, useShareToken } from '../contexts/ShareModeContext';
import { useEntry } from '../hooks/useEntries';
import { MarkdownRenderer } from './MarkdownRenderer';
import type { WikilinkResolutionData } from './WikilinkText';

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------

interface EntryEmbedProps {
  targetId: string | null;
  label: string;
  currentEntryId: string | undefined;
  wikis: WikilinkResolutionData;
  /**
   * Universe id — used for share/auth URL construction and the useEntry call.
   */
  universeId: string;
}

// ---------------------------------------------------------------------------
// Non-fatal affordance components
// ---------------------------------------------------------------------------

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
// ---------------------------------------------------------------------------

/**
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
  // ---------------------------------------------------------------------------
  const isSelf = !!targetId && targetId === currentEntryId;

  // Gate: pass '' for self-embed or null target so useEntry's
  // Honors the existing ['entry', universeId, entryId] key — no re-key.
  const fetchId = isSelf || !targetId ? '' : targetId;

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
  // ---------------------------------------------------------------------------
  if (isSelf) {
    return <CircularEmbedNotice label={label} entryTo={entryTo!} />;
  }

  // ---------------------------------------------------------------------------
  // ---------------------------------------------------------------------------

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
      className="my-4 rounded-md border border-line-strong bg-panel overflow-hidden"
    >
      {/* D-08 Attribution header: icon + title + nav glyph, as a link to the target */}
      <div className="px-4 pt-3 pb-2 border-b border-line">
        <Link
          data-testid="embed-attribution-link"
          to={entryTo!}
          className="inline-flex items-center gap-1.5 font-display text-[15px] font-semibold text-link hover:underline"
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
