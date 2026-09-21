import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import { useImportDraft } from '../hooks/useImportDraft';
import { useDebouncedCallback } from '../hooks/useDebouncedCallback';
import { useUniverse } from '../hooks/useUniverse';
import { useEntries } from '../hooks/useEntries';
import { classifyError, pluralize } from '../lib/format';
import type {
  CommitBody,
  CommitDecision,
  CommitEntry,
  CommitResult,
  EntryEdits,
  IngestPreview,
  PreviewEntry,
  ReviewDecisions,
} from '../types/ingestReview';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { ImportCommitProgress } from '../components/import/ImportCommitProgress';
import { ImportDetailPane } from '../components/import/ImportDetailPane';
import { ImportListPane } from '../components/import/ImportListPane';
import { ImportResumePrompt } from '../components/import/ImportResumePrompt';
import {
  ImportSidebarFilters,
  type ReviewFilters,
} from '../components/import/ImportSidebarFilters';
import { ImportStickyBar } from '../components/import/ImportStickyBar';
import {
  ImportUploadStep,
  requestPreview,
  type UploadSource,
} from '../components/import/ImportUploadStep';
import { SplitLevelControl } from '../components/import/SplitLevelControl';
import { DocxPromoteControl } from '../components/import/DocxPromoteControl';

/**
 *
 * Owns the parent state machine (UI-SPEC §6.1):
 *   check-draft → resume-prompt | upload
 *
 * ImportResumePrompt and ImportCommitProgress. The view is the single site of
 * the POST /api/universes/:uid/ingest/commit call (D-25), TanStack query
 * cache invalidation on success (D-28), the resume-from-localStorage prompt
 * (D-20), and the per-entry decisions reducer that debounce-saves the draft.
 *
 * D-23 invariant: NO overwrite UI surface here. Dispositions are limited to
 * accept | reject | rename | skip; the conflict UI offers skip/rename only.
 */

type Step =
  | { kind: 'check-draft' }
  | { kind: 'resume-prompt' }
  | { kind: 'upload' }
  | { kind: 'review' }
  | { kind: 'committing' }
  | { kind: 'commit-error'; message: string };

const DEFAULT_FILTERS: ReviewFilters = {
  status: 'all',
  categories: new Set<string>(),
  types: new Set<string>(),
};

function buildCommitBody(
  preview: IngestPreview,
  decisions: ReviewDecisions,
): CommitBody {
  const entries: CommitEntry[] = [];
  for (const entry of preview.entries) {
    const slot = decisions[entry.path];
    const decision: CommitDecision = slot?.decision ?? { disposition: 'accept' };
    if (decision.disposition === 'reject') continue;
    const edits = slot?.edits ?? {};
    const finalTitle =
      decision.disposition === 'rename'
        ? decision.newTitle
        : edits.title ?? entry.title;
    const finalCategory: { existingId: string } | { newName: string } | null =
      edits.category !== undefined
        ? edits.category
        : entry.category
          ? { newName: entry.category }
          : null;
    entries.push({
      filename: entry.filename,
      path: entry.path,
      title: finalTitle,
      entryType: edits.entryType ?? entry.type,
      tags: edits.tags ?? entry.tags,
      category: finalCategory,
      body: edits.body ?? entry.body,
      meta: edits.meta ?? entry.meta,
      linksOut: entry.linksOut.map(({ warning: _warning, ...rest }) => rest),
      decision:
        decision.disposition === 'rename'
          ? { disposition: 'rename', newTitle: decision.newTitle }
          : decision.disposition === 'skip'
            ? { disposition: 'skip' }
            : { disposition: 'accept' },
    });
  }
  return { entries };
}

function filterEntries(
  entries: PreviewEntry[],
  decisions: ReviewDecisions,
  filters: ReviewFilters,
  existingByLower: Map<string, string>,
): PreviewEntry[] {
  return entries.filter((e) => {
    const slot = decisions[e.path];
    const disp = slot?.decision.disposition ?? 'accept';
    const hasWarn = e.linksOut.some((l) => !l.resolved);
    const effectiveTitle =
      disp === 'rename'
        ? (slot!.decision as { disposition: 'rename'; newTitle: string }).newTitle
        : slot?.edits.title ?? e.title;
    const isCollision = existingByLower.has(effectiveTitle.toLowerCase());
    if (
      filters.status === 'accepted' &&
      disp !== 'accept' &&
      disp !== 'rename'
    )
      return false;
    if (filters.status === 'rejected' && disp !== 'reject') return false;
    if (
      filters.status === 'conflicts' &&
      !isCollision &&
      disp !== 'skip' &&
      disp !== 'rename'
    )
      return false;
    if (filters.status === 'warnings' && !hasWarn) return false;
    if (filters.categories.size > 0) {
      const cat =
        slot?.edits.category && 'newName' in slot.edits.category
          ? slot.edits.category.newName
          : e.category ?? '(Uncategorized)';
      if (!filters.categories.has(cat)) return false;
    }
    if (filters.types.size > 0) {
      const t = slot?.edits.entryType ?? e.type;
      if (!filters.types.has(t)) return false;
    }
    return true;
  });
}

function formatSuccessToast(r: CommitResult): string {
  const ePart = pluralize(r.entryIds.length, 'entry', 'entries');
  const lPart = pluralize(r.linksCreated, 'link', 'links');
  if (r.categoriesCreated === 0) {
    return `Imported ${ePart}, ${lPart}.`;
  }
  const cPart = pluralize(r.categoriesCreated, 'new category', 'new categories');
  return `Imported ${ePart}, ${lPart}, ${cPart}.`;
}

export function IngestImport() {
  const { uid } = useParams<{ uid: string }>();
  const navigate = useNavigate();
  const qc = useQueryClient();

  const { data: universe } = useUniverse(uid);
  const { data: existingEntries } = useEntries(uid ?? '');
  const { draft, save: saveDraft, clear: clearDraft } = useImportDraft(
    uid ?? '',
  );

  const [step, setStep] = useState<Step>({ kind: 'check-draft' });
  const [preview, setPreview] = useState<IngestPreview | null>(null);
  const [decisions, setDecisions] = useState<ReviewDecisions>({});
  const [focusedPath, setFocusedPath] = useState<string | null>(null);
  const [filters, setFilters] = useState<ReviewFilters>(DEFAULT_FILTERS);
  const [discardOpen, setDiscardOpen] = useState(false);
  // #37: the upload as posted, kept so the reviewer can re-request the preview
  const [source, setSource] = useState<UploadSource | null>(null);
  // pending state. The ref also closes the same-render window before React
  const [repreviewing, setRepreviewing] = useState(false);
  const repreviewPendingRef = useRef(false);
  const repreviewGenerationRef = useRef(0);
  const committingRef = useRef<HTMLDivElement>(null);

  // Mount: check-draft → resume-prompt | upload. Only on first render.
  useEffect(() => {
    if (step.kind !== 'check-draft') return;
    if (draft && draft.preview.entries.length > 0) {
      setStep({ kind: 'resume-prompt' });
    } else {
      setStep({ kind: 'upload' });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);


  // entry id. Consumers (ConflictChip aria-label, ConflictBanner copy) need
  const existingEntriesByLowerTitle = useMemo(() => {
    const m = new Map<string, string>();
    (existingEntries ?? []).forEach((e) => m.set(e.title.toLowerCase(), e.title));
    return m;
  }, [existingEntries]);
  const existingTitlesLower = useMemo(
    () => new Set(Array.from(existingEntriesByLowerTitle.keys())),
    [existingEntriesByLowerTitle],
  );

  const debouncedSave = useDebouncedCallback(
    (p: IngestPreview, d: ReviewDecisions) =>
      saveDraft({ preview: p, decisions: d }),
    300,
  );
  useEffect(() => {
    if (step.kind === 'review' && preview) {
      debouncedSave(preview, decisions);
    }
  }, [decisions, preview, step.kind, debouncedSave]);

  const discardDraft = useCallback(() => {
    debouncedSave.cancel();
    clearDraft();
  }, [debouncedSave, clearDraft]);

  const handleResumeContinue = () => {
    if (!draft) return;
    setPreview(draft.preview);
    setDecisions(draft.decisions);
    setFocusedPath(draft.preview.entries[0]?.path ?? null);
    setStep({ kind: 'review' });
  };

  const handleResumeDiscard = () => {
    discardDraft();
    setStep({ kind: 'upload' });
  };

  const handleParsed = (newPreview: IngestPreview, newSource: UploadSource) => {
    setPreview(newPreview);
    setSource(newSource);
    setDecisions({});
    setFocusedPath(newPreview.entries[0]?.path ?? null);
    setStep({ kind: 'review' });
    saveDraft({ preview: newPreview, decisions: {} });
  };

  const promotedIndicesFrom = (currentPreview: IngestPreview) =>
    new Set(
      (currentPreview.docx?.files ?? [])
        .filter((file) => file.headings.promoted)
        .map((file) => file.uploadIndex),
    );

  const requestReplacementPreview = async (
    splitLevel: number | null,
    promotedDocxIndices: ReadonlySet<number>,
  ) => {
    if (!source || !uid) return;
    const generation = ++repreviewGenerationRef.current;
    repreviewPendingRef.current = true;
    setRepreviewing(true);
    try {
      const next = await requestPreview(
        uid,
        source.files,
        source.kind,
        splitLevel,
        promotedDocxIndices,
      );
      if (generation !== repreviewGenerationRef.current) return;
      discardDraft();
      setPreview(next);
      setDecisions({});
      setFocusedPath(next.entries[0]?.path ?? null);
      saveDraft({ preview: next, decisions: {} });
    } catch (err) {
      if (generation !== repreviewGenerationRef.current) return;
      // Same canned-copy rule as the commit path (T-12-22): never surface a
      setStep({ kind: 'commit-error', message: classifyError(err) });
    } finally {
      if (generation === repreviewGenerationRef.current) {
        repreviewPendingRef.current = false;
        setRepreviewing(false);
      }
    }
  };

  const handleSplitLevelChange = async (level: number | null) => {
    if (!preview || repreviewing) return;
    await requestReplacementPreview(level, promotedIndicesFrom(preview));
  };

  const handleDocxPromotionChange = async (
    uploadIndex: number,
    promoted: boolean,
  ) => {
    if (!preview || repreviewing) return;
    const promotedDocxIndices = promotedIndicesFrom(preview);
    if (promoted) {
      promotedDocxIndices.add(uploadIndex);
    } else {
      promotedDocxIndices.delete(uploadIndex);
    }
    await requestReplacementPreview(
      preview.split?.applied ?? null,
      promotedDocxIndices,
    );
  };

  const handleUploadCancel = () => {
    if (uid) navigate(`/universes/${uid}/entries`);
  };

  const updateSlot = useCallback(
    (
      path: string,
      partial: Partial<{
        decision: CommitDecision;
        edits: EntryEdits;
        metaValid: boolean;
      }>,
    ) => {
      setDecisions((prev) => {
        const existing = prev[path] ?? {
          decision: { disposition: 'accept' as const },
          edits: {} as EntryEdits,
          metaValid: true,
        };
        return {
          ...prev,
          [path]: {
            ...existing,
            ...partial,
            edits: { ...existing.edits, ...(partial.edits ?? {}) },
          },
        };
      });
    },
    [],
  );

  const handleUpdateField = (
    path: string,
    field: keyof EntryEdits,
    value: unknown,
  ) => {
    updateSlot(path, { edits: { [field]: value } as Partial<EntryEdits> });
  };
  const handleUpdateDecision = (path: string, decision: CommitDecision) => {
    updateSlot(path, { decision });
  };
  const handleReject = (path: string) =>
    updateSlot(path, { decision: { disposition: 'reject' } });
  const handleRestore = (path: string) =>
    updateSlot(path, { decision: { disposition: 'accept' } });
  const handleMetaValidity = (path: string, valid: boolean) =>
    updateSlot(path, { metaValid: valid });

  const filteredEntries = useMemo(() => {
    if (!preview) return [];
    return filterEntries(
      preview.entries,
      decisions,
      filters,
      existingEntriesByLowerTitle,
    );
  }, [preview, decisions, filters, existingEntriesByLowerTitle]);

  const counts = useMemo(() => {
    if (!preview) {
      return {
        total: 0,
        warnings: 0,
        conflicts: 0,
        accepted: 0,
        rejected: 0,
        metaInvalid: false,
      };
    }
    let warnings = 0;
    let conflicts = 0;
    let accepted = 0;
    let rejected = 0;
    let metaInvalid = false;
    for (const e of preview.entries) {
      if (e.linksOut.some((l) => !l.resolved)) warnings += 1;
      const slot = decisions[e.path];
      const disp = slot?.decision.disposition ?? 'accept';
      if (
        slot &&
        slot.metaValid === false &&
        (disp === 'accept' || disp === 'rename')
      ) {
        metaInvalid = true;
      }
      const effective =
        disp === 'rename'
          ? (slot!.decision as { disposition: 'rename'; newTitle: string })
              .newTitle
          : slot?.edits.title ?? e.title;
      if (
        existingEntriesByLowerTitle.has(effective.toLowerCase()) ||
        disp === 'skip' ||
        disp === 'rename'
      ) {
        conflicts += 1;
      }
      if (disp === 'accept' || disp === 'rename') accepted += 1;
      if (disp === 'reject') rejected += 1;
    }
    return {
      total: preview.entries.length,
      warnings,
      conflicts,
      accepted,
      rejected,
      metaInvalid,
    };
  }, [preview, decisions, existingEntriesByLowerTitle]);

  const availableCategories = useMemo(() => {
    if (!preview) return [];
    const counts = new Map<string, number>();
    for (const e of preview.entries) {
      const cat = e.category ?? '(Uncategorized)';
      counts.set(cat, (counts.get(cat) ?? 0) + 1);
    }
    return Array.from(counts.entries()).map(([label, count]) => ({
      label,
      count,
    }));
  }, [preview]);

  const availableTypes = useMemo(() => {
    if (!preview) return [];
    const counts = new Map<string, number>();
    for (const e of preview.entries) counts.set(e.type, (counts.get(e.type) ?? 0) + 1);
    return Array.from(counts.entries()).map(([label, count]) => ({
      label,
      count,
    }));
  }, [preview]);

  const hasActiveFilters =
    filters.status !== 'all' ||
    filters.categories.size > 0 ||
    filters.types.size > 0;

  const rejectAllWithWarnings = () => {
    if (!preview) return;
    const next: ReviewDecisions = { ...decisions };
    for (const e of preview.entries) {
      if (e.linksOut.some((l) => !l.resolved)) {
        const existing = next[e.path] ?? {
          decision: { disposition: 'accept' as const },
          edits: {} as EntryEdits,
          metaValid: true,
        };
        next[e.path] = { ...existing, decision: { disposition: 'reject' } };
      }
    }
    setDecisions(next);
  };

  const rejectAllInCategory = () => {
    if (!preview || filters.categories.size !== 1) return;
    const cat = Array.from(filters.categories)[0];
    if (cat == null) return;
    const next: ReviewDecisions = { ...decisions };
    for (const e of preview.entries) {
      const entryCat = e.category ?? '(Uncategorized)';
      if (entryCat === cat) {
        const existing = next[e.path] ?? {
          decision: { disposition: 'accept' as const },
          edits: {} as EntryEdits,
          metaValid: true,
        };
        next[e.path] = { ...existing, decision: { disposition: 'reject' } };
      }
    }
    setDecisions(next);
  };

  const restoreAllRejected = () => {
    if (!preview) return;
    const next: ReviewDecisions = { ...decisions };
    for (const e of preview.entries) {
      const existing = next[e.path];
      if (existing && existing.decision.disposition === 'reject') {
        next[e.path] = { ...existing, decision: { disposition: 'accept' } };
      }
    }
    setDecisions(next);
  };

  const handleDiscard = () => setDiscardOpen(true);
  const handleDiscardConfirm = () => {
    discardDraft();
    setPreview(null);
    setSource(null);
    setDecisions({});
    setFocusedPath(null);
    setStep({ kind: 'upload' });
  };

  const handleClearFilters = () => setFilters(DEFAULT_FILTERS);

  const handleCommit = async () => {
    if (!preview || !uid || repreviewPendingRef.current) return;
    const body = buildCommitBody(preview, decisions);
    // D-29 belt-and-braces guard: sticky bar already disables commit when
    const committable = body.entries.filter(
      (e) => e.decision.disposition !== 'skip',
    );
    if (committable.length === 0) return;
    setStep({ kind: 'committing' });
    // UI-SPEC §9.3: focus shift to commit-progress wrapper on commit start.
    requestAnimationFrame(() => committingRef.current?.focus());
    try {
      const result = await api<CommitResult>(
        `/universes/${uid}/ingest/commit`,
        {
          method: 'POST',
          body: JSON.stringify(body),
        },
      );
      // Success path (D-28): clear localStorage, invalidate caches, navigate.
      discardDraft();
      qc.invalidateQueries({ queryKey: ['entries', uid] });
      qc.invalidateQueries({ queryKey: ['entry', uid] });
      qc.invalidateQueries({ queryKey: ['categories', uid] });
      qc.invalidateQueries({ queryKey: ['graph-data', uid] });
      qc.invalidateQueries({ queryKey: ['relations', uid] });
      qc.invalidateQueries({ queryKey: ['universe', uid] });
      const toast = formatSuccessToast(result);
      navigate(`/universes/${uid}/entries`, {
        replace: true,
        state: { toast, toastVariant: 'success' },
      });
    } catch (err) {
      const message = `Import failed. ${classifyError(err)} Your review is saved — try again or adjust and re-commit.`;
      setStep({ kind: 'commit-error', message });
    }
  };

  // UI-SPEC §9.1 keyboard nav. Skip when focus is in an editable field so
  const handleKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (step.kind !== 'review' || filteredEntries.length === 0) return;
    const target = e.target as HTMLElement;
    const inField =
      target.tagName === 'INPUT' ||
      target.tagName === 'TEXTAREA' ||
      target.isContentEditable;
    if (inField && e.key !== 'Escape') return;
    if (e.key === 'Escape') {
      setFilters(DEFAULT_FILTERS);
      e.preventDefault();
      return;
    }
    const idx = focusedPath
      ? filteredEntries.findIndex((x) => x.path === focusedPath)
      : -1;
    if (e.key === 'ArrowDown') {
      const next = filteredEntries[Math.min(idx + 1, filteredEntries.length - 1)];
      if (next) {
        setFocusedPath(next.path);
        e.preventDefault();
      }
    } else if (e.key === 'ArrowUp') {
      const prev = filteredEntries[Math.max(idx - 1, 0)];
      if (prev) {
        setFocusedPath(prev.path);
        e.preventDefault();
      }
    } else if (e.key === 'Home') {
      const first = filteredEntries[0];
      if (first) {
        setFocusedPath(first.path);
        e.preventDefault();
      }
    } else if (e.key === 'End') {
      const last = filteredEntries[filteredEntries.length - 1];
      if (last) {
        setFocusedPath(last.path);
        e.preventDefault();
      }
    }
  };

  // ---------------- Render branches ----------------

  if (!uid) return null;

  // Briefly nothing while we read localStorage on mount (UI-SPEC §7.1; <50ms).
  if (step.kind === 'check-draft') return null;

  if (step.kind === 'resume-prompt' && draft) {
    return (
      <ImportResumePrompt
        draft={draft}
        onContinue={handleResumeContinue}
        onDiscard={handleResumeDiscard}
      />
    );
  }

  if (step.kind === 'upload') {
    return (
      <ImportUploadStep
        universeId={uid}
        onParsed={handleParsed}
        onCancel={handleUploadCancel}
      />
    );
  }
  if (!preview || !universe) return null;

  const focusedEntry =
    preview.entries.find((e) => e.path === focusedPath) ?? preview.entries[0];
  const focusedSlot = focusedEntry ? decisions[focusedEntry.path] : undefined;
  const focusedDecision: CommitDecision = focusedSlot?.decision ?? {
    disposition: 'accept',
  };
  const focusedEdits: EntryEdits = focusedSlot?.edits ?? {};
  const focusedEffective = focusedEntry
    ? focusedDecision.disposition === 'rename'
      ? focusedDecision.newTitle
      : focusedEdits.title ?? focusedEntry.title
    : '';
  // BLOCK-1 fix: existingEntriesByLowerTitle maps lowercased title → original-
  const focusedMatched = focusedEffective
    ? existingEntriesByLowerTitle.get(focusedEffective.toLowerCase()) ?? null
    : null;

  const isCommitting = step.kind === 'committing';

  return (
    <section
      role="main"
      aria-label="Import review"
      className="-mx-6 -my-8 flex flex-col flex-1 min-h-0"
      onKeyDown={handleKeyDown}
    >
      {step.kind === 'commit-error' && (
        <div
          role="alert"
          className="bg-red-600 text-white px-4 py-3 text-sm flex items-start justify-between gap-4"
        >
          <p>{step.message}</p>
          <button
            type="button"
            onClick={() => setStep({ kind: 'review' })}
            aria-label="Dismiss"
            className="text-white/80 hover:text-white"
          >
            ×
          </button>
        </div>
      )}
      <ImportStickyBar
        universeId={uid}
        universeName={universe.name}
        totalEntries={counts.total}
        warningCount={counts.warnings}
        conflictCount={counts.conflicts}
        acceptedCount={counts.accepted}
        isCommitting={isCommitting}
        isPreviewPending={repreviewing}
        metaInvalid={counts.metaInvalid}
        onDiscard={handleDiscard}
        onCommit={handleCommit}
      />
      {isCommitting && (
        <ImportCommitProgress
          ref={committingRef}
          entryCount={counts.accepted}
          done={false}
          ariaLabel="Commit progress"
        />
      )}
      {/*
        #37 SP-04: only for a single-document batch (`eligible`), and only when
        the source files are still in hand — a resumed draft has the preview
        but not the upload, so re-splitting is impossible and offering the
        control would be a dead end.
      */}
      {preview.split?.eligible && source && (
        <SplitLevelControl
          detected={preview.split.detected}
          applied={preview.split.applied}
          counts={preview.split.counts}
          onChange={handleSplitLevelChange}
          disabled={repreviewing || isCommitting}
        />
      )}
      {/*
        #35 DOCX-09: only when the source files are still in hand — a
        resumed draft has the preview but not the upload, so re-requesting
        with promotion is impossible, same reasoning as the split control
        above. DocxPromoteControl itself renders nothing when there is
        nothing eligible to promote.
      */}
      {preview.docx && source && (
        <DocxPromoteControl
          files={preview.docx.files}
          onChange={handleDocxPromotionChange}
          disabled={repreviewing || isCommitting}
        />
      )}
      <div className="flex-1 flex min-h-0 overflow-hidden">
        <ImportSidebarFilters
          filters={filters}
          onChange={setFilters}
          availableCategories={availableCategories}
          availableTypes={availableTypes}
          warningCount={counts.warnings}
          rejectedCount={counts.rejected}
          onRejectAllWithWarnings={rejectAllWithWarnings}
          onRejectAllInCategory={rejectAllInCategory}
          onRestoreAllRejected={restoreAllRejected}
        />
        <ImportListPane
          entries={filteredEntries}
          decisions={decisions}
          focusedPath={focusedPath}
          existingEntriesByLowerTitle={existingEntriesByLowerTitle}
          onFocus={setFocusedPath}
          onClearFilters={handleClearFilters}
          hasActiveFilters={hasActiveFilters}
        />
        {focusedEntry ? (
          <ImportDetailPane
            entry={focusedEntry}
            edits={focusedEdits}
            decision={focusedDecision}
            validTypes={universe.entryTypes}
            universeId={uid}
            matchedTitle={focusedMatched}
            existingTitlesLower={existingTitlesLower}
            onUpdateField={(field, value) =>
              handleUpdateField(focusedEntry.path, field, value)
            }
            onUpdateDecision={(d) => handleUpdateDecision(focusedEntry.path, d)}
            onReject={() => handleReject(focusedEntry.path)}
            onRestore={() => handleRestore(focusedEntry.path)}
            onMetaValidityChange={(v) => handleMetaValidity(focusedEntry.path, v)}
          />
        ) : (
          <div className="flex-1" />
        )}
      </div>
      <ConfirmDialog
        open={discardOpen}
        onOpenChange={setDiscardOpen}
        title="Discard your import draft?"
        body={`This clears your in-progress review of ${pluralize(counts.total, 'entry', 'entries')}. The original Markdown files on your computer are untouched, but you'll have to re-upload and start over.`}
        confirmLabel="Discard draft"
        destructive
        onConfirm={handleDiscardConfirm}
      />
    </section>
  );
}
