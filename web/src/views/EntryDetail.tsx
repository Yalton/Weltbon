import { useMemo, useState } from 'react';
import { Link, useParams, useNavigate } from 'react-router-dom';
import { useEntries, useEntry, useDeleteEntry, type Entry } from '../hooks/useEntries';
import { useFilteredDictionary, useUniverseDictionary, type DictionaryWord } from '../hooks/useDictionary';
import { useTimelinePins } from '../hooks/useTimelinePins';
import { useCalendar } from '../hooks/useCalendar';
import { formatCalendar } from '../lib/calendarFormat';
import { TypeBadge } from '../components/TypeBadge';
import { WipPill } from '../components/WipPill';
import { MarkdownRenderer } from '../components/MarkdownRenderer';
import type { WikilinkResolutionData } from '../components/MarkdownRenderer';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { LinkSection } from '../components/LinkSection';
import { IssueSection } from '../components/IssueSection';
import { TimelinePinSection } from '../components/TimelinePinSection';
import { useShareMode, useShareCalendar } from '../contexts/ShareModeContext';

export function EntryDetail() {
  // Phase 29 — share-mode awareness. In share mode the route is
  // `/share/:token/entries/:entryId` (no `uid` param), so substitute
  // 'share' for the universe id; the api-client seam swaps the path to
  // /api/share/entries/:entryId.
  const { uid: paramUid, token, entryId } = useParams<{
    uid: string;
    token: string;
    entryId: string;
  }>();
  const isShareMode = useShareMode();
  const uid = paramUid ?? (isShareMode ? 'share' : undefined);
  const navigate = useNavigate();
  const { data: entry, isLoading, refetch } = useEntry(uid!, entryId!);
  const deleteEntry = useDeleteEntry(uid!);
  const [confirmOpen, setConfirmOpen] = useState(false);

  // Phase 30 — calendar date + "View on timeline →" (EVENTS-02 / D-11).
  // useTimelinePins is already cached if the user visited /timeline; no extra
  // fetch in the common case. useCalendar is a thin wrapper over useUniverse
  // (same cache key) — also zero extra fetches.
  // Phase 33 INT-BLOCKER-1 fix: in share mode useUniverse('share') 404s, so
  // calendar from useCalendar is null. Use the share calendar from context
  // (threaded from the share-meta endpoint via ShareLayout) as the effective
  // calendar when rendering inside the share subtree.
  const { data: pins } = useTimelinePins(uid!);
  const { calendar: authCalendar } = useCalendar(uid!);
  const shareCalendar = useShareCalendar();
  const calendar = isShareMode ? shareCalendar : authCalendar;

  // ── Resolution data for [[word]] wikilinks ───────────────────────────────
  // useEntries works in both authenticated and share mode: the api-client seam
  // rewrites /universes/<uid>/entries → /api/share/entries automatically when
  // shareTokenPlaintext is set. Public-only entries flow through the share path
  // (T-32-11: no private entry titles enter the share-mode resolution map).
  const { data: allEntries } = useEntries(uid!);

  // Build entryTitles map: lower(title.trim()) → entryId.
  // Phase 45 D-03: keyed on lowercase so [[empire]] resolves to "Empire".
  // Phase 45 D-04: API list is ordered by updatedAt DESC, so we sort by
  // created_at ASC before iterating — first-inserted entry (oldest created_at)
  // wins the slot when two titles collide on case-fold.
  const entryTitles = useMemo<Map<string, string>>(() => {
    const sorted = [...(allEntries ?? [])].sort((a, b) =>
      a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0,
    );
    const map = new Map<string, string>();
    for (const e of sorted) {
      const key = e.title.trim().toLowerCase();
      if (!map.has(key)) map.set(key, e.id); // D-04: oldest wins
    }
    return map;
  }, [allEntries]);

  // Phase 46 Plan 01 (D-11/D-12/D-13 hover-card content source).
  // Full entry objects keyed by id — built from the same useEntries(uid!) cache
  // already in use below. No new query, no re-key (memory: react-query-key-change-blast-radius).
  // In share mode useEntries flows through /api/share/entries which drops is_public=false rows
  // server-side (T-46-02 mitigate: private entries never enter the map in share mode).
  const entriesById = useMemo<Map<string, Entry>>(() => {
    const map = new Map<string, Entry>();
    for (const e of allEntries ?? []) map.set(e.id, e);
    return map;
  }, [allEntries]);

  // Phase 45 XREF-04 (D-01 slot 2): alias → entryId map. Case-insensitive keys.
  // Same created_at ASC sort ensures first-inserted alias wins on collision (D-04/D-05).
  const entryAliases = useMemo<Map<string, string>>(() => {
    const sorted = [...(allEntries ?? [])].sort((a, b) =>
      a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0,
    );
    const map = new Map<string, string>();
    for (const e of sorted) {
      for (const alias of e.aliases ?? []) {
        const key = alias.trim().toLowerCase();
        if (!map.has(key)) map.set(key, e.id); // first alias wins on duplicate
      }
    }
    return map;
  }, [allEntries]);

  // Determine the linked language entry (D-02 scope): find an outbound link
  // whose targetEntryId resolves to a 'language'-type entry in the entries list.
  // We cross-reference outboundLinks (has targetEntryId) with allEntries (has
  // entryType). The `entry` object is not yet in scope here (early return above
  // is absent), so we guard against undefined.
  // NOTE: this useMemo runs after `entry` is loaded (see early return below).
  const linkedLanguageEntryId = useMemo<string | null>(() => {
    if (!entry || !allEntries) return null;
    const entryMap = new Map(allEntries.map((e) => [e.id, e]));
    for (const link of entry.outboundLinks ?? []) {
      const linked = entryMap.get(link.targetEntryId);
      if (linked?.entryType === 'language') {
        return linked.id;
      }
    }
    return null;
  }, [entry, allEntries]);

  // D-02 language-scoped dictionary (when entry links a language entry).
  // Always called (hooks can't be conditional); disabled when no linked lang.
  const { data: langScopedWords } = useFilteredDictionary(
    uid!,
    { q: '', lid: linkedLanguageEntryId },
  );

  // D-02 universe-wide dictionary UNION (when entry links NO language entry).
  // Fetches null-scope fallback + every language dict and merges them.
  // In share mode the seam translates each fetch to /api/share/dictionary?lid=...
  const { words: universeWords } = useUniverseDictionary(uid!);

  // Build dictionaryWords map per D-02 scope rule:
  //   linked language entry → use langScopedWords only
  //   no linked language entry → use the universe-wide union (universeWords)
  const dictionaryWords = useMemo<Map<string, DictionaryWord>>(() => {
    const map = new Map<string, DictionaryWord>();
    const source = linkedLanguageEntryId ? (langScopedWords ?? []) : universeWords;
    for (const w of source) {
      const key = w.word.toLowerCase();
      if (!map.has(key)) map.set(key, w);
    }
    return map;
  }, [linkedLanguageEntryId, langScopedWords, universeWords]);

  if (isLoading || !entry) return <p className="text-sm text-neutral-500">Loading...</p>;

  // Resolve the pin for THIS entry (may be undefined if not pinned).
  const entryPin = pins?.find((p) => p.entryId === entryId);
  // Compute calendar date from pin position (D-11).
  const calendarDate = entryPin ? formatCalendar(entryPin.position, calendar) : null;

  const handleDelete = async () => {
    await deleteEntry.mutateAsync(entryId!);
    navigate(`/universes/${uid}/entries`, { replace: true });
  };

  const metaEntries = Object.entries(entry.meta as Record<string, string>);

  // ── wikis resolution data ─────────────────────────────────────────────────
  // Authenticated branch: pass onAddWord → navigates to dictionary with
  //   ?prefill=<token> so the user can add the missing word.
  // Share branch (isShareMode): no onAddWord (T-32-11 — no mutation surface
  //   for visitors; amber affordance rendered without "+" button per WikilinkText).
  const wikis: WikilinkResolutionData = {
    entryTitles,
    entryAliases, // Phase 45 XREF-04 — alias tier, covers both auth + share paths (EntryDetail reuse)
    dictionaryWords,
    universeId: uid!,
    languageEntryId: linkedLanguageEntryId,
    onAddWord: isShareMode
      ? undefined
      : (token: string) => {
          const params = new URLSearchParams({ prefill: token });
          navigate(`/universes/${uid}/dictionary?${params.toString()}`);
        },
    // Phase 33 INT-BLOCKER-2 fix: thread share-mode flag + token so
    // WikilinkText can build /share/:token/entries/:id targets instead of
    // /universes/:uid/entries/:id (which lands on ProtectedRoute → /login
    // for unauthenticated share visitors).
    isShareMode,
    shareToken: token ?? null,
    // Phase 46 Plan 01 (D-11/D-12/D-13): full entry objects for hover-card content.
    // Built from the already-cached useEntries list (no new query, no re-key).
    entriesById,
    // Phase 46 Plan 01 (D-06 guard source): the route id of the entry currently
    // being viewed — Plan 03's EntryEmbed compares embed target id against this
    // to detect and render the circular/self-embed affordance instead of expanding.
    // This is the SOLE wiring site for currentEntryId; Plan 03 only consumes it.
    currentEntryId: entryId,
    // embedDepth is intentionally omitted at the top level — undefined = depth 0
    // = embeds expand (D-05 flatten: depth-1 is set by EntryEmbed's recursive call).
  };

  return (
    <div className="max-w-3xl mx-auto">
      {/* Back link */}
      <Link
        to={
          isShareMode
            ? `/share/${token ?? ''}`
            : `/universes/${uid}/entries`
        }
        className="text-sm text-neutral-400 hover:text-neutral-200"
      >
        &larr; Back to entries
      </Link>

      {/* Header block */}
      <div className="mt-4">
        <div className="flex items-center gap-3">
          {entry.icon && <span className="text-[28px] leading-none">{entry.icon}</span>}
          <h1 className="text-2xl font-semibold tracking-tight">{entry.title}</h1>
        </div>
        <div className="mt-1 flex items-center gap-2">
          <TypeBadge type={entry.entryType} />
          {/* Phase 36 DATA-03 — non-interactive WIP badge next to the
              TypeBadge / Public chip when entry.wip === true. */}
          {entry.wip && <WipPill wip />}
          {/*
            Phase 29 SHARE-04 / UI-SPEC §C / D-16 — accent-tint Public chip
            rendered next to TypeBadge ONLY when entry.isPublic === true.
            Visible in BOTH authenticated and share-view contexts per
            UI-SPEC §A Kept-affordances + T-29-34 (accept): the chip helps
            the visitor understand they're viewing a public entry, and
            helps the owner see which entries are marked public from the
            detail view. Eye icon (10×10 SVG) is aria-hidden="true"
            (decorative); the <span>Public</span> text remains readable
            by screen readers (Accessibility Checklist §C).
          */}
          {entry.isPublic && (
            <span className="inline-flex items-center gap-1 rounded px-2 py-1 text-sm font-semibold bg-[color:var(--color-accent)]/10 text-[color:var(--color-accent)]">
              <svg
                aria-hidden="true"
                width="10"
                height="10"
                viewBox="0 0 16 16"
                fill="currentColor"
              >
                <path d="M8 3C4.667 3 1.787 5.013 .5 8c1.287 2.987 4.167 5 7.5 5s6.213-2.013 7.5-5C14.213 5.013 11.333 3 8 3zm0 8.333A3.333 3.333 0 1 1 8 4.667a3.333 3.333 0 0 1 0 6.666zm0-5.333a2 2 0 1 0 0 4 2 2 0 0 0 0-4z" />
              </svg>
              <span>Public</span>
            </span>
          )}
        </div>
        {/*
          Phase 29 D-18 / UI-SPEC §A Kept-affordances — in share mode the
          Edit and Delete buttons are hidden entirely. The visitor has no
          authenticated session and the share read namespace exposes no
          mutation surface; surfacing these controls would mislead.
        */}
        {!isShareMode && (
          <div className="flex gap-2 mt-3">
            <Link
              to={`/universes/${uid}/entries/${entryId}/edit`}
              className="rounded-md border border-neutral-300 dark:border-neutral-700 text-sm px-3 py-1.5"
            >
              Edit
            </Link>
            <button
              type="button"
              onClick={() => setConfirmOpen(true)}
              className="rounded-md bg-red-600 text-white text-sm px-3 py-1.5"
            >
              Delete
            </button>
          </div>
        )}
      </div>

      {/*
        Phase 30 EVENTS-02 / D-11 — Calendar date + "View on timeline →".
        Rendered when this entry has a timeline pin AND (for calendar date)
        the universe has a calendar. When no calendar → falls back to the
        raw position (CALENDAR-03). When no pin → section is omitted.
        Read-only-safe: no edit chrome; works identically in share mode.
      */}
      {entryPin && (
        <div className="mt-4 flex flex-col gap-1">
          {/* Calendar date (full form) or raw position fallback */}
          <div className="text-sm text-neutral-600 dark:text-neutral-400">
            {calendarDate ? (
              <>
                {calendarDate.weekday && (
                  <span className="mr-1">{calendarDate.weekday},</span>
                )}
                <span>
                  {calendarDate.day} {calendarDate.monthName},{' '}
                  {calendarDate.year} {calendarDate.eraAbbr}
                </span>
                {calendarDate.moonPhases.length > 0 && (
                  <span className="ml-2 text-neutral-500">
                    {calendarDate.moonPhases
                      .map((mp) => `${mp.name}: ${mp.phase}`)
                      .join(', ')}
                  </span>
                )}
              </>
            ) : (
              <span className="tabular-nums font-mono">
                Position: {entryPin.position}
              </span>
            )}
          </div>
          {/* "View on timeline →" accent link */}
          <Link
            to={`/universes/${uid}/timeline`}
            className="text-sm text-[color:var(--color-accent)] hover:underline"
          >
            View on timeline &rarr;
          </Link>
        </div>
      )}

      {/* Summary */}
      {entry.summary && (
        <p className="text-base leading-[1.6] text-neutral-700 dark:text-neutral-300 mt-4">
          {entry.summary}
        </p>
      )}

      {/* Tags */}
      {entry.tags && entry.tags.length > 0 && (
        <div className="mt-4 flex flex-wrap gap-2">
          {entry.tags.map((tag) => (
            <span
              key={tag}
              className="rounded-full bg-neutral-800 dark:bg-neutral-800 px-2 py-1 text-sm"
            >
              {tag}
            </span>
          ))}
        </div>
      )}

      {/* Cover image (D-06) — between header block and body markdown (Phase 38 MEDIA-04).
          Phase 38 UAT-fix: use the pre-signed coverImageUrl from the API response so
          <img src> can load without Authorization: Bearer (which browsers can't attach
          to image tag fetches). Falls back to building the URL from coverImageId for
          older API responses that don't yet include coverImageUrl. */}
      {(entry.coverImageUrl ?? entry.coverImageId) && (
        <div className="mt-4 mb-4">
          <img
            src={
              entry.coverImageUrl ??
              (isShareMode
                ? `/api/share/assets/${entry.coverImageId}/raw`
                : `/api/universes/${uid}/assets/${entry.coverImageId}/raw`)
            }
            alt={`Cover image for ${entry.title}`}
            className="max-w-full rounded-lg"
            onError={(e) => {
              (e.target as HTMLImageElement).style.display = 'none';
            }}
          />
        </div>
      )}

      {/* Body (Markdown) — Phase 32 Plan 04 D-01/D-02/D-03/D-04 [[word]] resolution.
          wikis is always provided: authenticated branch includes onAddWord;
          share branch omits onAddWord (T-32-11 read-only, no mutation surface).
          entryTitles + dictionaryWords are derived from public-scoped data in
          share mode (via the api-client seam → /api/share/entries + /api/share/dictionary).
          Phase 38 MEDIA-05: assets prop threads universeId + shareToken + assetUrls so the
          components.img resolver uses pre-signed URLs from the API response (UAT-fix) and
          can build the correct authed/share raw URL as fallback. */}
      {entry.body && (
        <div className="mt-6">
          <MarkdownRenderer
            content={entry.body}
            wikis={wikis}
            assets={{ universeId: uid!, shareToken: token ?? null, assetUrls: entry.assetUrls }}
          />
        </div>
      )}

      {/* Links + Backlinks */}
      <LinkSection
        outboundLinks={entry.outboundLinks}
        backlinks={entry.backlinks}
        universeId={uid!}
        entryId={entryId!}
        onLinkCreated={() => refetch()}
      />

      {/*
        Phase 29 D-18 / UI-SPEC §A Kept-affordances — IssueSection is
        hidden in share mode (issues are an owner workflow surface;
        visitor must not see or affect them). TimelinePinSection on the
        detail view exposes the pin label + a manage control to upsert
        the pin position; the entire mutation surface is removed, so we
        omit the section. The visitor still sees timeline pin context on
        the dedicated TimelineView (pin click navigates to entry).
      */}
      {!isShareMode && (
        <>
          <IssueSection
            universeId={uid!}
            entryId={entryId!}
            issues={entry.issues ?? []}
            onChanged={() => refetch()}
          />
          <TimelinePinSection universeId={uid!} entryId={entryId!} />
        </>
      )}

      {/* Meta section */}
      {metaEntries.length > 0 && (
        <div className="mt-6 pt-6 border-t border-neutral-200 dark:border-neutral-800">
          <h2 className="text-xl font-semibold">Details</h2>
          <div className="mt-4 grid grid-cols-2 gap-2">
            {metaEntries.map(([key, val]) => (
              <div key={key} className="contents">
                <span className="text-sm text-neutral-400">{key}</span>
                <span className="text-sm text-right">{val}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Delete confirmation dialog */}
      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title={`Delete "${entry.title}"?`}
        body="This permanently removes the entry and all its links. Other entries that link here will lose their connections. This cannot be undone."
        confirmLabel="Delete"
        destructive
        onConfirm={handleDelete}
      />
    </div>
  );
}
