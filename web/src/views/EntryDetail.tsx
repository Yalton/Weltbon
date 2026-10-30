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
import { UnlinkedMentionsPanel } from '../components/UnlinkedMentionsPanel';
import { useShareMode, useShareCalendar } from '../contexts/ShareModeContext';
import { resolveMedallion } from '../lib/medallion';
import { EntryHero } from '../components/EntryHero';
import { Panel } from '../components/ui/Panel';
import { Button } from '../components/ui/Button';
import { Loading } from '../components/ui/Loading';

export function EntryDetail() {
  // 'share' for the universe id; the api-client seam swaps the path to
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

  // (threaded from the share-meta endpoint via ShareLayout) as the effective
  const { data: pins } = useTimelinePins(uid!);
  const { calendar: authCalendar } = useCalendar(uid!);
  const shareCalendar = useShareCalendar();
  const calendar = isShareMode ? shareCalendar : authCalendar;

  // useEntries works in both authenticated and share mode: the api-client seam
  // shareTokenPlaintext is set. Public-only entries flow through the share path
  // (T-32-11: no private entry titles enter the share-mode resolution map).
  const { data: allEntries } = useEntries(uid!);

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

  // already in use below. No new query, no re-key (memory: react-query-key-change-blast-radius).
  // server-side (T-46-02 mitigate: private entries never enter the map in share mode).
  const entriesById = useMemo<Map<string, Entry>>(() => {
    const map = new Map<string, Entry>();
    for (const e of allEntries ?? []) map.set(e.id, e);
    return map;
  }, [allEntries]);

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
  const { data: langScopedWords } = useFilteredDictionary(
    uid!,
    { q: '', lid: linkedLanguageEntryId },
  );

  // D-02 universe-wide dictionary UNION (when entry links NO language entry).
  // Fetches null-scope fallback + every language dict and merges them.
  const { words: universeWords } = useUniverseDictionary(uid!);

  // Build dictionaryWords map per D-02 scope rule:
  // no linked language entry → use the universe-wide union (universeWords)
  const dictionaryWords = useMemo<Map<string, DictionaryWord>>(() => {
    const map = new Map<string, DictionaryWord>();
    const source = linkedLanguageEntryId ? (langScopedWords ?? []) : universeWords;
    for (const w of source) {
      const key = w.word.toLowerCase();
      if (!map.has(key)) map.set(key, w);
    }
    return map;
  }, [linkedLanguageEntryId, langScopedWords, universeWords]);

  if (isLoading || !entry) return <Loading />;

  const entryPin = pins?.find((p) => p.entryId === entryId);
  // Compute calendar date from pin position (D-11).
  const calendarDate = entryPin ? formatCalendar(entryPin.position, calendar) : null;

  const handleDelete = async () => {
    await deleteEntry.mutateAsync(entryId!);
    navigate(`/universes/${uid}/entries`, { replace: true });
  };

  const metaEntries = Object.entries(entry.meta as Record<string, string>);

  // Share branch (isShareMode): no onAddWord (T-32-11 — no mutation surface
  const wikis: WikilinkResolutionData = {
    entryTitles,
    entryAliases,
    dictionaryWords,
    universeId: uid!,
    languageEntryId: linkedLanguageEntryId,
    onAddWord: isShareMode
      ? undefined
      : (token: string) => {
          const params = new URLSearchParams({ prefill: token });
          navigate(`/universes/${uid}/dictionary?${params.toString()}`);
        },
    isShareMode,
    shareToken: token ?? null,
    // Built from the already-cached useEntries list (no new query, no re-key).
    entriesById,
    // to detect and render the circular/self-embed affordance instead of expanding.
    currentEntryId: entryId,
    // = embeds expand (D-05 flatten: depth-1 is set by EntryEmbed's recursive call).
  };

  // Content-Forward Views §5 — every entry gets a hero. A cover becomes a scrimmed banner; a
  // The hero draws entry.coverImageUrl — the DETAIL endpoint's pre-signed RAW url. It is NOT
  // coverThumbUrl (list-only), so the hero is NOT a Medallion; resolveMedallion supplies only the
  // no-cover identity (monogram + type hue), keeping that fallback consistent with every other
  const hero = resolveMedallion({
    title: entry.title,
    entryType: entry.entryType,
    icon: entry.icon,
  });
  // The pre-signed url wins; the coverImageId fallback is retained for older API responses that
  // predate coverImageUrl (and preserves the share-vs-auth raw path difference).
  const coverSrc =
    entry.coverImageUrl ??
    (entry.coverImageId
      ? isShareMode
        ? `/api/share/assets/${entry.coverImageId}/raw`
        : `/api/universes/${uid}/assets/${entry.coverImageId}/raw`
      : null);

  return (
    <div className="mx-auto max-w-5xl lg:grid lg:grid-cols-[minmax(0,1fr)_18rem] lg:gap-8 lg:items-start">
      <div className="min-w-0">
        {/* Back link */}
        <Link
          to={
            isShareMode
              ? `/share/${token ?? ''}`
              : `/universes/${uid}/entries`
          }
          className="text-sm text-ink-muted hover:text-ink-muted"
        >
          &larr; Back to entries
        </Link>

        {/* Hero (§5) — a cover banner, or a type-hued watermark band when there is no cover.
            Either way the title sits inside it, so the page opens with an image-scale masthead
            instead of a form header.

            The shell (components/EntryHero) owns the height model and the layering, and is shared
            with EntryEditor so the two can never drift apart: the visual layer is absolute, THESE
            CHILDREN are in flow, and the content is what defines the hero's height. pt-16 reserves
            the banner's headroom above the title. */}
        <EntryHero
          testId="entry-hero"
          className="mt-4"
          coverSrc={coverSrc}
          coverAlt={`Cover image for ${entry.title}`}
          medallion={hero}
        >
          <div className="p-4 pt-16">
            <h1 className="font-display text-3xl font-semibold tracking-tight text-ink">
              {entry.title}
            </h1>
            <div className="mt-2 flex items-center gap-2">
              <TypeBadge type={entry.entryType} />

              {entry.wip && <WipPill wip />}

              {entry.isPublic && (
                <span className="inline-flex items-center gap-1 rounded px-2 py-1 text-sm font-semibold bg-[color:var(--color-accent)]/10 text-accent-ink">
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
          </div>
        </EntryHero>


        {!isShareMode && (
          <div className="flex gap-2 mt-3">
            <Link
              to={`/universes/${uid}/entries/${entryId}/edit`}
              className="btn-accent rounded-lg px-4 py-2 text-sm font-semibold text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--color-accent)]"
            >
              Edit
            </Link>
            <Button variant="danger" onClick={() => setConfirmOpen(true)}>
              Delete
            </Button>
          </div>
        )}


        {entryPin && (
          <div className="mt-4 flex flex-col gap-1">
            {/* Calendar date (full form) or raw position fallback */}
            <div className="text-sm text-ink-secondary">
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
                    <span className="ml-2 text-ink-muted">
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
          <p className="text-lg leading-relaxed text-ink-secondary mt-4">
            {entry.summary}
          </p>
        )}

        {/* Tags */}
        {entry.tags && entry.tags.length > 0 && (
          <div className="mt-4 flex flex-wrap gap-2">
            {entry.tags.map((tag) => (
              <span
                key={tag}
                className="rounded-full bg-raised px-2 py-1 text-sm"
              >
                {tag}
              </span>
            ))}
          </div>
        )}

        {/* The cover image is no longer rendered here — §5 promoted it into the hero above.
            Rendering it in both places would show the same image twice. */}


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


        {!isShareMode && (
          <>
            <IssueSection
              universeId={uid!}
              entryId={entryId!}
              issues={entry.issues ?? []}
              onChanged={() => refetch()}
            />
            <TimelinePinSection universeId={uid!} entryId={entryId!} />

            <UnlinkedMentionsPanel
              universeId={uid!}
              entry={entry}
              allEntries={allEntries ?? []}
              onLinked={() => refetch()}
            />
          </>
        )}
      </div>

      {/* Infobox (§5) — meta/custom fields as a glass column beside the content on lg+,
          stacking below it on narrow screens. Replaces the old bottom "Details" grid.
          lg:sticky only travels if the grid item is height-auto rather than stretched — that is
          what lg:items-start on the grid container buys it; lg:top-6 is its anchor. */}
      {metaEntries.length > 0 && (
        <Panel data-testid="entry-infobox" className="mt-6 p-4 lg:sticky lg:top-6 lg:mt-4">
          <h2 className="font-display text-lg font-semibold text-ink">Details</h2>
          <dl className="mt-3 space-y-2">
            {metaEntries.map(([key, val]) => (
              <div key={key} className="flex items-baseline justify-between gap-3">
                <dt className="text-sm text-ink-muted">{key}</dt>
                <dd className="text-sm text-right text-ink">{val}</dd>
              </div>
            ))}
          </dl>
        </Panel>
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
