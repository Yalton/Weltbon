import { useState, useEffect, useRef } from 'react';
import { useParams, useNavigate, Link, useLocation } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { useEntry, useCreateEntry, useUpdateEntry, useEntries, previewEntryUpdate } from '../hooks/useEntries';
import { useAssets } from '../hooks/useAssets';
import { useUniverse } from '../hooks/useUniverse';
import { TagInput } from '../components/TagInput';
import { MetaEditor } from '../components/MetaEditor';
import { EntryCategoryPicker } from '../components/EntryCategoryPicker';
import SaveAsTemplateDialog from '../components/SaveAsTemplateDialog';
import { Toast } from '../components/Toast';
import { Toggle } from '../components/Toggle';
import { WipPill } from '../components/WipPill';
import { AssetPickerModal } from '../components/AssetPickerModal';
import {
  MarkdownAuthoringEditor,
  type MarkdownAuthoringEditorHandle,
  type MarkdownAuthoringSelection,
} from '../components/MarkdownAuthoringEditor';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { MarkdownOutline, type MarkdownHeading } from '../components/MarkdownOutline';
import {
  MarkdownBacklinks,
  type MarkdownAssetRecoverySelection,
  type MarkdownRecoverySelection,
} from '../components/MarkdownBacklinks';
import { metaArrayToRecord } from '../lib/entryTemplates';
import { resolveMedallion } from '../lib/medallion';
import { EntryHero } from '../components/EntryHero';
import type { Entry } from '../hooks/useEntries';
import type { EntryTemplate } from '../lib/entryTemplates';
import { Loading } from '../components/ui/Loading';
import { buttonClasses } from '../components/ui/Button';

const entryFormSchema = z.object({
  title: z.string().min(1, 'Title is required').max(200),
  entryType: z.string().min(1, 'Type is required'),
  summary: z.string().max(500),
  body: z.string(),
  icon: z.string().max(10),
});

type EntryFormValues = z.infer<typeof entryFormSchema>;

export function EntryEditor() {
  const { uid, entryId } = useParams<{ uid: string; entryId: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const isEditMode = !!entryId;

  const { data: universe } = useUniverse(uid);
  const { data: existingEntry, isLoading: entryLoading } = useEntry(uid!, entryId ?? '');
  const createEntry = useCreateEntry(uid!);
  const updateEntry = useUpdateEntry(uid!, entryId ?? '');
  // instant `[[` is typed, closing the async-empty window CR-01 flagged. The picker
  // owns its own useEntries subscription AND the active selection (CR-01); this call
  const { data: allEntries = [] } = useEntries(uid ?? '');
  const { data: assets } = useAssets(uid ?? '');

  const [tags, setTags] = useState<string[]>([]);
  const [aliases, setAliases] = useState<string[]>([]);
  const [meta, setMeta] = useState<Record<string, string>>({});
  const [categoryId, setCategoryId] = useState<string | null>(null);
  const [metaValid, setMetaValid] = useState(true);
  const [saveAsOpen, setSaveAsOpen] = useState(false);
  const [toast, setToast] = useState<{ message: string; variant: 'success' | 'error' } | null>(null);
  const [propagateConfirmOpen, setPropagateConfirmOpen] = useState(false);
  const [propagateAffectedLinks, setPropagateAffectedLinks] = useState(0);
  const [propagateAffectedEntries, setPropagateAffectedEntries] = useState(0);
  const [propagatePendingPayload, setPropagatePendingPayload] = useState<Record<string, unknown> | null>(null);
  // When rewriteCount > 0, we show the after-summary toast and then navigate
  const [pendingNavigationPath, setPendingNavigationPath] = useState<string | null>(null);
  // new entries (0023 share-public-by-default); seeded from existingEntry.isPublic on edit.
  const [isPublic, setIsPublic] = useState(true);
  // seeded from existingEntry.wip on edit. Independent of isPublic (T-36-06-01).
  const [wip, setWip] = useState(false);
  const [coverImageId, setCoverImageId] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerMode, setPickerMode] = useState<'insert-embed' | 'set-cover'>('insert-embed');
  const markdownEditorRef = useRef<MarkdownAuthoringEditorHandle>(null);
  const [assetReplacementSelection, setAssetReplacementSelection] = useState<MarkdownAssetRecoverySelection | null>(null);
  // CR-03: gate the create-mode template prefill so it runs at most once per
  // stale-time expiry) re-runs the prefill effect and silently wipes any
  const prefilledRef = useRef(false);

  const {
    register,
    handleSubmit,
    reset,
    getValues,
    setValue,
    watch,
    formState: { errors, isDirty },
  } = useForm<EntryFormValues>({
    resolver: zodResolver(entryFormSchema),
    defaultValues: {
      title: '',
      entryType: '',
      summary: '',
      body: '',
      icon: '',
    },
  });

  // from watch() (not getValues()) so the medallion re-resolves on every keystroke —
  // the DRAFT, not the last-saved entry, drives the preview.
  const watchedTitle = watch('title');
  const watchedEntryType = watch('entryType');
  const watchedIcon = watch('icon');
  const watchedBody = watch('body');
  const heroMedallion = resolveMedallion({
    title: watchedTitle,
    entryType: watchedEntryType,
    icon: watchedIcon,
  });

  // Pre-fill in edit mode, or from template state in create mode.
  useEffect(() => {
    if (isEditMode && existingEntry) {
      reset({
        title: existingEntry.title,
        entryType: existingEntry.entryType,
        summary: existingEntry.summary ?? '',
        body: existingEntry.body ?? '',
        icon: existingEntry.icon ?? '',
      });
      setTags(existingEntry.tags ?? []);
      setAliases(existingEntry.aliases ?? []);
      setMeta((existingEntry.meta as Record<string, string>) ?? {});
      setCategoryId(existingEntry.categoryId ?? null);
      // Fallback true (0023 share-public-by-default) for the no-value edge case.
      setIsPublic(existingEntry.isPublic ?? true);
      setWip(existingEntry.wip ?? false);
      setCoverImageId((existingEntry as Entry & { coverImageId?: string | null }).coverImageId ?? null);
      return;
    }
    // CR-03 fix — prefilledRef gates re-runs so a TanStack Query refetch of
    // `universe` (window focus, stale-time expiry) does NOT silently wipe
    // effect re-fires once universe loads — the entryType <select>'s options
    // must be mounted before react-hook-form's reset() can apply the templated
    // value to the DOM; the ref-guard then makes every subsequent refetch a
    // no-op so user-typed content is preserved.
    if (!prefilledRef.current && universe?.entryTypes) {
      const template = (location.state as { template?: EntryTemplate } | null)
        ?.template;
      if (template) {
        reset({
          title: '',
          entryType: template.entryType,
          summary: '',
          body: template.body,
          icon: '',
        });
        // D-10: transform array meta blueprint to Record for the editor's state shape
        setMeta(metaArrayToRecord(template.meta));
        setTags([]);
        setCategoryId(null);
      }
      prefilledRef.current = true;
    }
  }, [isEditMode, existingEntry, reset, location.state, universe?.entryTypes]);

  if (isEditMode && entryLoading) {
    return <Loading />;
  }

  const handlePropagateConfirm = async () => {
    if (!propagatePendingPayload) return;
    const result = await updateEntry.mutateAsync(propagatePendingPayload as Parameters<typeof updateEntry.mutateAsync>[0]);
    const rewriteCount = result?.rewriteCount;
    setPropagatePendingPayload(null);
    setPropagateConfirmOpen(false);
    const destPath = `/universes/${uid}/entries/${entryId}`;
    // D-10: show after-summary "N links rewritten" via the existing toast mechanism.
    if (typeof rewriteCount === 'number' && rewriteCount > 0) {
      setToast({ message: `${rewriteCount} link${rewriteCount === 1 ? '' : 's'} rewritten`, variant: 'success' });
      setPendingNavigationPath(destPath);
    } else {
      navigate(destPath, { replace: true });
    }
  };

  const onSubmit = handleSubmit(async (values) => {
    // D-16: read templateId from location.state and forward to POST /entries
    const stateTemplateId = (
      location.state as { template?: EntryTemplate; templateId?: string } | null
    )?.templateId ?? null;

    const payload = {
      title: values.title,
      entryType: values.entryType,
      summary: values.summary,
      body: values.body,
      icon: values.icon,
      tags,
      aliases,
      meta,
      categoryId,
      isPublic,
      wip,
      coverImageId,
      ...(stateTemplateId ? { templateId: stateTemplateId } : {}),
    };

    if (isEditMode) {
      // (D-06 trigger set: title rename, alias rename, alias removal).
      const oldTitle = existingEntry?.title ?? '';
      const oldAliases = existingEntry?.aliases ?? [];
      const newTitle = values.title;
      const newAliases = aliases;
      const titleChanged = oldTitle !== newTitle;
      // in the new alias set (D-06: title rename, alias rename, alias removal).
      // Adding a new alias never triggers (D-06: add-only contributes nothing).
      const newNamesSet = new Set([newTitle.toLowerCase(), ...newAliases.map((a) => a.toLowerCase())]);
      const mightPropagate =
        titleChanged ||
        oldAliases.some((a) => !newNamesSet.has(a.toLowerCase()));

      if (mightPropagate && uid && entryId) {
        // Call the write-free preview to get the affected-link count (D-08).
        const preview = await previewEntryUpdate(uid, entryId, payload);
        const affected = preview.affectedLinks ?? 0;
        if (affected > 0) {
          // Store the pending payload and open the confirm dialog (D-08).
          setPropagatePendingPayload(payload as unknown as Record<string, unknown>);
          setPropagateAffectedLinks(affected);
          setPropagateAffectedEntries(preview.affectedEntries ?? 0);
          setPropagateConfirmOpen(true);
          return;
        }
      }

      // Silent path: 0 affected links, or non-propagating change (D-08).
      const result = await updateEntry.mutateAsync(payload);
      const rewriteCount = result?.rewriteCount;
      // D-10: show after-summary even on the silent path if the server propagated.
      if (typeof rewriteCount === 'number' && rewriteCount > 0) {
        setToast({ message: `${rewriteCount} link${rewriteCount === 1 ? '' : 's'} rewritten`, variant: 'success' });
      }
      navigate(`/universes/${uid}/entries/${entryId}`, { replace: true });
    } else {
      const created = await createEntry.mutateAsync(payload);
      navigate(`/universes/${uid}/entries/${(created as Entry).id}`, { replace: true });
    }
  });

  const entryTypes = universe?.entryTypes ?? [];
  const isPending = createEntry.isPending || updateEntry.isPending;

  const handlePickerSelect = (assetId: string) => {
    if (assetReplacementSelection) {
      markdownEditorRef.current?.replaceSelection(
        assetReplacementSelection,
        `![${assetReplacementSelection.altText}](asset://${assetId})`,
      );
      setAssetReplacementSelection(null);
    } else if (pickerMode === 'insert-embed') {
      markdownEditorRef.current?.insertMarkdown(`![image](asset://${assetId})`);
    } else {
      // set-cover mode
      setCoverImageId(assetId);
    }
    setPickerOpen(false);
  };

  const handlePickerOpenChange = (open: boolean) => {
    if (!open) setAssetReplacementSelection(null);
    setPickerOpen(open);
  };

  const revealMarkdownSelection = (selection: MarkdownAuthoringSelection | MarkdownRecoverySelection) => {
    markdownEditorRef.current?.revealSelection(selection);
  };

  const handleOutlineNavigate = (heading: MarkdownHeading) => {
    markdownEditorRef.current?.navigateToHeading(heading.anchor);
  };

  const handleReplaceAsset = (selection: MarkdownAssetRecoverySelection) => {
    markdownEditorRef.current?.revealSelection(selection);
    setAssetReplacementSelection(selection);
    setPickerMode('insert-embed');
    setPickerOpen(true);
  };

  const savedCoverImageId =
    (existingEntry as (Entry & { coverImageId?: string | null }) | undefined)?.coverImageId ?? null;
  const sameList = (a: readonly string[], b: readonly string[]) =>
    a.length === b.length && a.every((value, i) => value === b[i]);
  // Tags, aliases, meta and the toggles live outside react-hook-form, so they are
  // compared against the loaded entry by hand.
  const hasUnsavedChanges =
    isDirty ||
    (isEditMode &&
      !!existingEntry &&
      (!sameList(tags, existingEntry.tags ?? []) ||
        !sameList(aliases, existingEntry.aliases ?? []) ||
        JSON.stringify(meta) !== JSON.stringify(existingEntry.meta ?? {}) ||
        categoryId !== (existingEntry.categoryId ?? null) ||
        isPublic !== (existingEntry.isPublic ?? true) ||
        wip !== (existingEntry.wip ?? false) ||
        coverImageId !== savedCoverImageId));
  const saveStatus = isPending
    ? 'Saving…'
    : !isEditMode
      ? 'Not saved yet'
      : hasUnsavedChanges
        ? 'Unsaved changes'
        : 'All changes saved';

  const fieldClasses =
    'w-full rounded-md border border-line-strong bg-canvas-lo px-3 py-2 text-sm text-ink';

  return (
    <div className="max-w-6xl mx-auto">
      <h1 className="text-sm font-semibold uppercase tracking-wide text-ink-muted mb-3">
        {isEditMode ? 'Edit entry' : 'New entry'}
      </h1>

      <form
        onSubmit={onSubmit}
        className="grid gap-x-8 gap-y-6 lg:grid-cols-[minmax(0,1fr)_18rem]"
      >
        {/* Writing column: title and body lead; structured fields follow. */}
        <div className="min-w-0 space-y-5">
          <div>
            <label htmlFor="entry-title" className="sr-only">
              Title
            </label>
            <input
              id="entry-title"
              {...register('title')}
              placeholder="Untitled entry"
              className="w-full border-0 border-b border-line bg-transparent px-0 pb-2 font-display text-[28px] font-semibold leading-tight tracking-tight text-ink placeholder:text-ink-muted focus:border-[color:var(--color-accent)] focus:outline-none"
            />
            {errors.title && (
              <p className="text-sm text-rose-300 mt-1">{errors.title.message}</p>
            )}
          </div>

          {/* Body (Markdown) + Insert image (D-05) */}
          <div>
            <div className="flex items-center justify-between mb-1">
              <label htmlFor="entry-body" className="block text-sm text-ink-secondary">
                Body
              </label>
              <button
                type="button"
                onClick={() => {
                  setAssetReplacementSelection(null);
                  setPickerMode('insert-embed');
                  setPickerOpen(true);
                }}
                className="text-xs text-link hover:underline"
              >
                Insert image
              </button>
            </div>
            <MarkdownAuthoringEditor
              ref={markdownEditorRef}
              value={watchedBody}
              onChange={(markdown) => setValue('body', markdown, { shouldDirty: true, shouldValidate: true })}
              universeId={uid ?? ''}
              entryId={entryId}
              disabled={isPending}
            />
          </div>

          {/* Meta */}
          <div>
            <label className="block text-sm mb-1 text-ink-secondary">Details</label>
            <MetaEditor
              value={meta}
              onChange={setMeta}
              onValidityChange={setMetaValid}
              registeredFields={universe?.fieldRegistry ?? []}
              universeId={uid}
            />
          </div>
        </div>

        {/* Entry metadata: what the entry is, how it is filed, how it looks. */}
        <aside className="min-w-0 space-y-3">
          <section aria-label="Entry settings" className="space-y-4 rounded-md border border-line bg-panel p-4">
            <div>
              <label htmlFor="entry-type" className="block text-sm mb-1 text-ink-secondary">
                Type
              </label>
              <select id="entry-type" {...register('entryType')} className={fieldClasses}>
                <option value="">Select a type</option>
                {entryTypes.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
              {errors.entryType && (
                <p className="text-sm text-rose-300 mt-1">{errors.entryType.message}</p>
              )}
            </div>

            <div>
              <label htmlFor="entry-category" className="block text-sm mb-1 text-ink-secondary">
                Category
              </label>
              <EntryCategoryPicker
                id="entry-category"
                universeId={uid!}
                value={categoryId}
                onChange={setCategoryId}
              />
            </div>

            <div>
              <label htmlFor="entry-icon" className="block text-sm mb-1 text-ink-secondary">
                Icon
              </label>
              <input
                id="entry-icon"
                {...register('icon')}
                placeholder="Emoji"
                className="w-20 rounded-md border border-line-strong bg-canvas-lo px-3 py-2 text-sm text-ink"
              />
            </div>

            <div>
              <label htmlFor="entry-summary" className="block text-sm mb-1 text-ink-secondary">
                Summary
              </label>
              <textarea id="entry-summary" rows={3} {...register('summary')} className={fieldClasses} />
            </div>

            <div>
              <label className="block text-sm mb-1 text-ink-secondary">Tags</label>
              <div className="rounded-md border border-line-strong bg-canvas-lo px-3 py-2">
                <TagInput value={tags} onChange={setTags} />
              </div>
            </div>

            <div>
              <label className="block text-sm mb-1 text-ink-secondary">Aliases</label>
              <div className="rounded-md border border-line-strong bg-canvas-lo px-3 py-2">
                <TagInput value={aliases} onChange={setAliases} />
              </div>
            </div>

            <div>
              <label className="block text-sm mb-1 text-ink-secondary">Cover image</label>
              <EntryHero
                testId="editor-hero"
                // on it — so the src is built directly. Authenticated-only surface: no share path.
                coverSrc={coverImageId ? `/api/universes/${uid}/assets/${coverImageId}/thumb` : null}
                coverAlt={`Cover image for ${watchedTitle || 'this entry'}`}
                medallion={heroMedallion}
              >
                <div className="flex items-center gap-2 p-4">
                  {coverImageId ? (
                    <>
                      <button
                        type="button"
                        onClick={() => {
                          setPickerMode('set-cover');
                          setPickerOpen(true);
                        }}
                        className="text-xs rounded-md border border-white/40 bg-black/65 text-white px-3 py-1.5 hover:bg-black/80"
                      >
                        Change cover
                      </button>
                      <button
                        type="button"
                        onClick={() => setCoverImageId(null)}
                        className="text-xs rounded-md border border-white/40 bg-black/65 text-red-300 px-3 py-1.5 hover:bg-black/80"
                      >
                        Remove cover
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      onClick={() => {
                        setPickerMode('set-cover');
                        setPickerOpen(true);
                      }}
                      className="text-sm rounded-md border border-line-strong px-3 py-1.5 hover:bg-white/5"
                    >
                      Set cover image
                    </button>
                  )}
                </div>
              </EntryHero>
            </div>
          </section>

          <details className="rounded-md border p-3 border-line bg-panel">
            <summary className="cursor-pointer text-sm font-medium text-ink">
              Outline
            </summary>
            <div className="mt-3">
              <MarkdownOutline markdown={watchedBody} onNavigate={handleOutlineNavigate} />
            </div>
          </details>
          <details className="rounded-md border p-3 border-line bg-panel">
            <summary className="cursor-pointer text-sm font-medium text-ink">
              Backlinks &amp; Recovery
            </summary>
            <div className="mt-3">
              <MarkdownBacklinks
                universeId={uid ?? ''}
                backlinks={existingEntry?.backlinks ?? []}
                draftMarkdown={watchedBody}
                savedMarkdown={existingEntry?.body ?? ''}
                savedAssetUrls={existingEntry?.assetUrls ?? {}}
                assets={assets}
                entries={allEntries}
                onRevealSelection={revealMarkdownSelection}
                onReplaceAsset={handleReplaceAsset}
              />
            </div>
          </details>
        </aside>

        {/* Action bar, sticky from md up so Save stays reachable on long bodies; on phones it would cover a quarter of the screen. */}
        <div className="z-10 flex flex-wrap items-center justify-between gap-3 border-t border-line bg-chrome px-4 py-3 md:sticky md:bottom-0 lg:col-span-2">
          <Link
            to={
              isEditMode
                ? `/universes/${uid}/entries/${entryId}`
                : `/universes/${uid}/entries`
            }
            className="text-sm text-ink-muted hover:text-ink"
          >
            {isEditMode ? 'Discard changes' : 'Cancel'}
          </Link>

          {/* Right cluster — UI-SPEC §B: [Kebab] [Public toggle + label] [Save]. */}
          <div className="flex flex-wrap items-center gap-3">

          {/* Kebab overflow menu — D-14 / UI-SPEC §B */}
          <DropdownMenu.Root>
            <DropdownMenu.Trigger asChild>
              <button
                type="button"
                aria-label="Entry actions"
                className="inline-flex items-center justify-center h-8 w-8 rounded-md text-ink-secondary bg-transparent hover:text-ink hover:bg-white/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--color-accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[color:var(--color-canvas-mid)] data-[state=open]:bg-white/5 data-[state=open]:text-ink"
              >
                <svg
                  viewBox="0 0 16 16"
                  width="16"
                  height="16"
                  fill="currentColor"
                  aria-hidden="true"
                  focusable="false"
                >
                  <circle cx="8" cy="3" r="1.5" />
                  <circle cx="8" cy="8" r="1.5" />
                  <circle cx="8" cy="13" r="1.5" />
                </svg>
              </button>
            </DropdownMenu.Trigger>
            <DropdownMenu.Portal>
              <DropdownMenu.Content
                align="end"
                sideOffset={4}
                className="min-w-[160px] rounded-md border border-line bg-panel p-1 shadow-lg z-50 data-[state=open]:animate-popover-in data-[state=closed]:animate-popover-out"
              >
                <DropdownMenu.Item
                  onSelect={() => setSaveAsOpen(true)}
                  className="px-3 py-2 text-sm rounded-sm cursor-pointer outline-none data-[highlighted]:bg-white/5"
                >
                  Save as template…
                </DropdownMenu.Item>
              </DropdownMenu.Content>
            </DropdownMenu.Portal>
          </DropdownMenu.Root>


          <div className="flex items-center gap-2">
            <Toggle
              checked={isPublic}
              onChange={setIsPublic}
              labelId={`public-label-${entryId ?? 'new'}`}
              title={
                isPublic
                  ? 'This entry is visible in shared views'
                  : 'Make this entry visible in shared views'
              }
            />
            <span
              id={`public-label-${entryId ?? 'new'}`}
              className={`text-sm ${
                isPublic
                  ? ' text-ink'
                  : ' text-ink-secondary'
              }`}
            >
              Public
            </span>
          </div>


          <div className="flex items-center gap-2">
            <WipPill wip={wip} onToggle={() => setWip(!wip)} />
            <span
              id={`wip-label-${entryId ?? 'new'}`}
              className={`text-sm ${
                wip
                  ? 'text-amber-600 dark:text-amber-400'
                  : ' text-ink-secondary'
              }`}
            >
              Mark as WIP
            </span>
          </div>

          <p role="status" aria-live="polite" className="flex items-center gap-1.5 text-xs text-ink-muted">
            {hasUnsavedChanges && !isPending && (
              <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-amber-400" />
            )}
            {saveStatus}
          </p>

          <button
            type="submit"
            disabled={isPending || !metaValid}
            className={buttonClasses('primary')}
          >
            {isPending
              ? 'Saving...'
              : isEditMode
                ? 'Save changes'
                : 'Create entry'}
          </button>
          </div>
        </div>
      </form>


      {uid && (
        <AssetPickerModal
          open={pickerOpen}
          onOpenChange={handlePickerOpenChange}
          universeId={uid}
          mode={pickerMode}
          onSelect={handlePickerSelect}
        />
      )}

      {/* Save-as-template dialog — D-15 */}
      <SaveAsTemplateDialog
        open={saveAsOpen}
        onOpenChange={setSaveAsOpen}
        entryType={getValues('entryType')}
        captureSnapshot={() => ({
          summary: getValues('summary'),
          body: getValues('body'),
          // D-15 write-path: Record<string,string> → Array<{name, default_value}>
          meta: Object.entries(meta).map(([name, default_value]) => ({ name, default_value })),
        })}
        onSuccess={() => setToast({ message: 'Template saved.', variant: 'success' })}
        onGenericError={() =>
          setToast({ message: "Couldn't save the template. Try again.", variant: 'error' })
        }
      />

      {/* Toast notifications */}
      {toast && (
        <Toast
          message={toast.message}
          variant={toast.variant}
          onDismiss={() => {
            setToast(null);
            if (pendingNavigationPath) {
              const dest = pendingNavigationPath;
              setPendingNavigationPath(null);
              navigate(dest, { replace: true });
            }
          }}
        />
      )}


      <ConfirmDialog
        open={propagateConfirmOpen}
        onOpenChange={(open) => {
          if (!open) {
            // Cancel: close dialog, discard pending payload — no write (D-09).
            setPropagateConfirmOpen(false);
            setPropagatePendingPayload(null);
          }
        }}
        title="Update links?"
        body={`This will update ${propagateAffectedLinks} link${propagateAffectedLinks === 1 ? '' : 's'} across ${propagateAffectedEntries} entr${propagateAffectedEntries === 1 ? 'y' : 'ies'}.`}
        confirmLabel="Proceed"
        onConfirm={handlePropagateConfirm}
      />
    </div>
  );
}
