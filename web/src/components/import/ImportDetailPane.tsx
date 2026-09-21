import { useEffect, useMemo, useState } from 'react';
import type {
  CommitDecision,
  EntryEdits,
  PreviewEntry,
} from '../../types/ingestReview';
import { TagInput } from '../TagInput';
import { MetaEditor } from '../MetaEditor';
import { MarkdownRenderer } from '../MarkdownRenderer';
import { ConflictBanner } from './ConflictBanner';
import { IngestCategoryPicker } from './IngestCategoryPicker';
import { ImportLinksList } from './ImportLinksList';

export interface ImportDetailPaneProps {
  entry: PreviewEntry;
  edits: EntryEdits;
  decision: CommitDecision;
  validTypes: string[];
  universeId: string;
  matchedTitle: string | null;
  existingTitlesLower: Set<string>;
  onUpdateField: (field: keyof EntryEdits, value: unknown) => void;
  onUpdateDecision: (decision: CommitDecision) => void;
  onReject: () => void;
  onRestore: () => void;
  onMetaValidityChange: (valid: boolean) => void;
}

export function ImportDetailPane({
  entry,
  edits,
  decision,
  validTypes,
  universeId,
  matchedTitle,
  existingTitlesLower,
  onUpdateField,
  onUpdateDecision,
  onReject,
  onRestore,
  onMetaValidityChange,
}: ImportDetailPaneProps) {
  // Local state for inline-edit drafts. Re-syncs ONLY on entry.path change
  // clobbered by parent re-renders. T-12-18.
  const [titleDraft, setTitleDraft] = useState<string>(
    () => edits.title ?? entry.title,
  );
  const [bodyDraft, setBodyDraft] = useState<string>(
    () => edits.body ?? entry.body,
  );
  const [bodyMode, setBodyMode] = useState<'edit' | 'preview'>('edit');

  useEffect(() => {
    setTitleDraft(edits.title ?? entry.title);
    setBodyDraft(edits.body ?? entry.body);
    setBodyMode('edit');
    // Intentionally only depends on entry.path — focus-switch is the only
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entry.path]);

  const currentType = edits.entryType ?? entry.type;
  const typeIsValid = validTypes.includes(currentType);

  // string-typed updates back (a Record<string,string> is a valid
  const metaForEditor: Record<string, string> = useMemo(() => {
    const source = edits.meta ?? entry.meta;
    return Object.fromEntries(
      Object.entries(source).map(([k, v]) => [k, v == null ? '' : String(v)]),
    );
  }, [edits.meta, entry.meta]);

  const titleId = `detail-title-${entry.path}`;
  const typeId = `detail-type-${entry.path}`;
  const categoryId = `detail-category-${entry.path}`;
  const bodyId = `detail-body-${entry.path}`;

  // Default category value: if the parser produced a non-null category
  // the name pre-filled with "Will be created" — silent server-side merge
  // collapses case-insensitive matches at commit time (CONTEXT.md
  const categoryValue: { existingId: string } | { newName: string } | null =
    edits.category !== undefined
      ? edits.category
      : entry.category
        ? { newName: entry.category }
        : null;

  const unresolvedLinks = entry.linksOut.filter((l) => !l.resolved);

  return (
    <section
      role="region"
      aria-labelledby={titleId}
      className="flex-1 min-w-0 overflow-y-auto p-6"
    >
      <div className="max-w-2xl mx-auto">
        {/* 1. Conflict banner */}
        {matchedTitle !== null &&
          (decision.disposition === 'skip' ||
            decision.disposition === 'rename') && (
            <div className="mb-6">
              <ConflictBanner
                matchedTitle={matchedTitle}
                universeName="this universe"
                decision={decision}
                effectiveTitle={
                  decision.disposition === 'rename'
                    ? decision.newTitle
                    : entry.title
                }
                onUpdateDecision={onUpdateDecision}
                originalTitle={entry.title}
                existingTitlesLower={existingTitlesLower}
                entryPath={entry.path}
              />
            </div>
          )}

        {/* 2. Title */}
        <div>
          <label htmlFor={titleId} className="sr-only">
            Title
          </label>
          <input
            id={titleId}
            type="text"
            value={titleDraft}
            onChange={(e) => setTitleDraft(e.target.value)}
            onBlur={() => {
              if (titleDraft !== (edits.title ?? entry.title)) {
                onUpdateField('title', titleDraft);
              }
            }}
            maxLength={200}
            aria-required="true"
            aria-invalid={titleDraft.trim() === ''}
            aria-label="Title"
            className="w-full text-2xl font-semibold tracking-tight bg-transparent border-b border-transparent hover:border-neutral-300 dark:hover:border-neutral-700 focus:border-[color:var(--color-accent)] focus:outline-none px-0 py-1"
          />
          {titleDraft.trim() === '' && (
            <p role="alert" className="text-xs text-red-500 mt-1">
              Title is required
            </p>
          )}
          {titleDraft.length === 200 && (
            <p className="text-xs text-amber-500 mt-1">
              Title must be 200 characters or fewer
            </p>
          )}
        </div>

        {/* 3. Type + Category */}
        <div className="mt-6 grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label htmlFor={typeId} className="block text-sm mb-1">
              Type
            </label>
            <select
              id={typeId}
              value={currentType}
              onChange={(e) => onUpdateField('entryType', e.target.value)}
              aria-invalid={!typeIsValid}
              className="w-full rounded-md border border-neutral-300 dark:border-neutral-700 bg-transparent px-3 py-2 text-sm"
            >
              {/*
                If currentType is NOT in validTypes, render a non-disabled
                option so the <select> can still display the current value.
                The defensive case is communicated via the inline error
                BELOW per UI-SPEC OVERRIDE §5.2 — NEVER as a disabled
                <option> (cross-browser inconsistency).
              */}
              {!typeIsValid && (
                <option value={currentType}>{currentType}</option>
              )}
              {validTypes.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
            {!typeIsValid && (
              <p role="alert" className="text-xs text-red-500 mt-1">
                &quot;{currentType}&quot; isn&apos;t a type in this universe.
                Pick another, or add it to the universe before committing.
              </p>
            )}
          </div>
          <div>
            <label htmlFor={categoryId} className="block text-sm mb-1">
              Category
            </label>
            <IngestCategoryPicker
              id={categoryId}
              universeId={universeId}
              value={categoryValue}
              onChange={(value) => onUpdateField('category', value)}
            />
          </div>
        </div>

        {/* 4. Tags */}
        <div className="mt-6 pt-6 border-t border-neutral-200 dark:border-neutral-800">
          <h2 className="text-xl font-semibold mb-2">Tags</h2>
          <div className="rounded-md border border-neutral-300 dark:border-neutral-700 px-3 py-2">
            <TagInput
              value={edits.tags ?? entry.tags}
              onChange={(tags) => onUpdateField('tags', tags)}
            />
          </div>
        </div>

        {/* 5. Warnings (one amber inline pill per unresolved link) */}
        {unresolvedLinks.length > 0 && (
          <div className="mt-6 pt-6 border-t border-neutral-200 dark:border-neutral-800">
            <h2 className="text-xl font-semibold mb-2">Warnings</h2>
            <div className="flex flex-wrap gap-2">
              {unresolvedLinks.map((w, i) => (
                <span
                  key={`${w.target}-${i}`}
                  role="status"
                  className="inline-flex items-center gap-1 rounded-md bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-300 px-2 py-1 text-xs"
                >
                  <span aria-hidden>⚠</span>
                  <span>Unresolved link: {w.target}</span>
                </span>
              ))}
            </div>
          </div>
        )}

        {/* 6. Body — Edit/Preview toggle */}
        <div className="mt-6 pt-6 border-t border-neutral-200 dark:border-neutral-800">
          <div className="flex items-center justify-between mb-2">
            <h2 className="text-xl font-semibold">
              <label htmlFor={bodyId}>Body</label>
            </h2>
            <div className="inline-flex rounded-md border border-neutral-300 dark:border-neutral-700 overflow-hidden text-xs">
              <button
                type="button"
                onClick={() => setBodyMode('edit')}
                className={
                  bodyMode === 'edit'
                    ? 'px-3 py-1 bg-neutral-200 dark:bg-neutral-800 font-medium'
                    : 'px-3 py-1 text-neutral-500'
                }
              >
                Edit
              </button>
              <button
                type="button"
                onClick={() => setBodyMode('preview')}
                className={
                  bodyMode === 'preview'
                    ? 'px-3 py-1 bg-neutral-200 dark:bg-neutral-800 font-medium'
                    : 'px-3 py-1 text-neutral-500'
                }
              >
                Preview
              </button>
            </div>
          </div>
          {bodyMode === 'edit' ? (
            <textarea
              id={bodyId}
              rows={16}
              value={bodyDraft}
              onChange={(e) => setBodyDraft(e.target.value)}
              onBlur={() => {
                if (bodyDraft !== (edits.body ?? entry.body)) {
                  onUpdateField('body', bodyDraft);
                }
              }}
              className="w-full rounded-md border border-neutral-300 dark:border-neutral-700 bg-transparent px-3 py-2 text-sm font-mono leading-[1.5]"
            />
          ) : (
            <div className="rounded-md border border-neutral-200 dark:border-neutral-800 px-4 py-3">
              <MarkdownRenderer content={bodyDraft} />
            </div>
          )}
        </div>

        {/* 7. Details (Meta) */}
        <div className="mt-6 pt-6 border-t border-neutral-200 dark:border-neutral-800">
          <h2 className="text-xl font-semibold mb-2">Details</h2>
          <MetaEditor
            value={metaForEditor}
            onChange={(meta) => onUpdateField('meta', meta)}
            onValidityChange={onMetaValidityChange}
          />
        </div>

        {/* 8. Links */}
        <ImportLinksList linksOut={entry.linksOut} />

        {/* 9. Reject / Restore */}
        <div className="mt-6 pt-6 border-t border-neutral-200 dark:border-neutral-800 flex justify-end">
          {decision.disposition === 'reject' ? (
            <button
              type="button"
              onClick={onRestore}
              aria-pressed="true"
              className="text-sm text-neutral-700 dark:text-neutral-200 hover:text-[color:var(--color-accent)] px-3 py-1.5"
            >
              Restore this entry
            </button>
          ) : (
            <button
              type="button"
              onClick={onReject}
              aria-pressed="false"
              className="text-sm text-neutral-700 dark:text-neutral-200 hover:text-red-600 px-3 py-1.5"
            >
              Reject this entry
            </button>
          )}
        </div>
      </div>
    </section>
  );
}
