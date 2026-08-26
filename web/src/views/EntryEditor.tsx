import { useState, useEffect, useRef } from 'react';
import { useParams, useNavigate, Link, useLocation } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { useEntry, useCreateEntry, useUpdateEntry, useEntries, previewEntryUpdate } from '../hooks/useEntries';
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
  // Phase 47 XREF-01 — warm the ['entries', uid] cache so the picker has data the
  // instant `[[` is typed, closing the async-empty window CR-01 flagged. The picker
  // owns its own useEntries subscription AND the active selection (CR-01); this call
  // is prefetch only — its result is intentionally not bound or used for ranking.
  const { data: allEntries = [] } = useEntries(uid ?? '');

  const [tags, setTags] = useState<string[]>([]);
  // Phase 45 XREF-04 (D-09) — alias chips placed immediately after Tags field.
  const [aliases, setAliases] = useState<string[]>([]);
  const [meta, setMeta] = useState<Record<string, string>>({});
  const [categoryId, setCategoryId] = useState<string | null>(null);
  const [metaValid, setMetaValid] = useState(true);
  const [saveAsOpen, setSaveAsOpen] = useState(false);
  const [toast, setToast] = useState<{ message: string; variant: 'success' | 'error' } | null>(null);
  // Phase 48 XREF-05 (D-08/D-09/D-10) — two-phase save state.
  // When a rename/alias change would affect N>0 links, the preview count is
  // stored here and the confirm dialog opens. On Proceed the pending payload
  // is committed; on Cancel the dialog closes with no write.
  const [propagateConfirmOpen, setPropagateConfirmOpen] = useState(false);
  const [propagateAffectedLinks, setPropagateAffectedLinks] = useState(0);
  const [propagateAffectedEntries, setPropagateAffectedEntries] = useState(0);
  const [propagatePendingPayload, setPropagatePendingPayload] = useState<Record<string, unknown> | null>(null);
  // Phase 48 XREF-05 (D-10) — deferred navigation path after a toast is shown.
  // When rewriteCount > 0, we show the after-summary toast and then navigate
  // when the user dismisses it (better UX than navigating before the toast is seen).
  const [pendingNavigationPath, setPendingNavigationPath] = useState<string | null>(null);
  // Phase 29 SHARE-04 / UI-SPEC §B / D-10 — Public toggle state. Default TRUE on
  // new entries (0023 share-public-by-default); seeded from existingEntry.isPublic on edit.
  const [isPublic, setIsPublic] = useState(true);
  // Phase 36 DATA-03 — WIP/draft toggle state. Default false on new entries;
  // seeded from existingEntry.wip on edit. Independent of isPublic (T-36-06-01).
  const [wip, setWip] = useState(false);
  // Phase 38 MEDIA-04/05 — cover image + insert-embed picker state.
  const [coverImageId, setCoverImageId] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerMode, setPickerMode] = useState<'insert-embed' | 'set-cover'>('insert-embed');
  const markdownEditorRef = useRef<MarkdownAuthoringEditorHandle>(null);
  const [assetReplacementSelection, setAssetReplacementSelection] = useState<MarkdownAssetRecoverySelection | null>(null);
  // CR-03: gate the create-mode template prefill so it runs at most once per
  // navigation. Without this, every refetch of `universe` (window focus,
  // stale-time expiry) re-runs the prefill effect and silently wipes any
  // content the user has typed into the form.
  const prefilledRef = useRef(false);

  const {
    register,
    handleSubmit,
    reset,
    getValues,
    setValue,
    watch,
    formState: { errors },
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

  // Content-Forward Views §5 (Task 10) — the editor hero previews exactly what the
  // detail page will render, so the author sees the result before saving. Derived
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
      // Phase 29 SHARE-04 — seed the Public toggle from the loaded entry.
      // Fallback true (0023 share-public-by-default) for the no-value edge case.
      setIsPublic(existingEntry.isPublic ?? true);
      // Phase 36 DATA-03 — seed the WIP toggle from the loaded entry.
      setWip(existingEntry.wip ?? false);
      // Phase 38 MEDIA-04 — seed coverImageId from the loaded entry.
      setCoverImageId((existingEntry as Entry & { coverImageId?: string | null }).coverImageId ?? null);
      return;
    }
    // Create mode: prefill from location.state.template ONCE per navigation.
    // CR-03 fix — prefilledRef gates re-runs so a TanStack Query refetch of
    // `universe` (window focus, stale-time expiry) does NOT silently wipe
    // the user's typed content. `universe?.entryTypes` stays in the deps so the
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

  // Phase 48 XREF-05 (D-10) — commit the pending payload after confirm.
  // Called from the ConfirmDialog's onConfirm prop (Proceed button).
  const handlePropagateConfirm = async () => {
    if (!propagatePendingPayload) return;
    const result = await updateEntry.mutateAsync(propagatePendingPayload as Parameters<typeof updateEntry.mutateAsync>[0]);
    const rewriteCount = result?.rewriteCount;
    setPropagatePendingPayload(null);
    setPropagateConfirmOpen(false);
    const destPath = `/universes/${uid}/entries/${entryId}`;
    // D-10: show after-summary "N links rewritten" via the existing toast mechanism.
    // Defer navigation until the user dismisses the toast so they can read it.
    if (typeof rewriteCount === 'number' && rewriteCount > 0) {
      setToast({ message: `${rewriteCount} link${rewriteCount === 1 ? '' : 's'} rewritten`, variant: 'success' });
      setPendingNavigationPath(destPath);
    } else {
      navigate(destPath, { replace: true });
    }
  };

  const onSubmit = handleSubmit(async (values) => {
    // D-16: read templateId from location.state and forward to POST /entries
    // Treated as opaque — no shape parsing/branching
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
      // Phase 29 SHARE-04 — Plan 03 surface accepts isPublic on POST + PATCH.
      isPublic,
      // Phase 36 DATA-03 — Plan 03 surface accepts wip on POST + PATCH.
      wip,
      // Phase 38 MEDIA-04 — forward coverImageId through the entries submit.
      coverImageId,
      ...(stateTemplateId ? { templateId: stateTemplateId } : {}),
    };

    if (isEditMode) {
      // Phase 48 XREF-05 (D-08/D-09) — two-phase save for rename/alias changes.
      // Determine if the title or aliases changed in a way that could break links
      // (D-06 trigger set: title rename, alias rename, alias removal).
      const oldTitle = existingEntry?.title ?? '';
      const oldAliases = existingEntry?.aliases ?? [];
      const newTitle = values.title;
      const newAliases = aliases;
      const titleChanged = oldTitle !== newTitle;
      // Propagation triggers when title changes or any old alias is no longer
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
          // Return early — the actual commit will happen in handlePropagateConfirm.
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

  // Asset selection remains in the existing modal. The authoring editor owns
  // insertion so the form continues to receive one canonical Markdown string.
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
    revealMarkdownSelection({ start: heading.start, end: heading.end });
  };

  const handleReplaceAsset = (selection: MarkdownAssetRecoverySelection) => {
    markdownEditorRef.current?.revealSelection(selection);
    setAssetReplacementSelection(selection);
    setPickerMode('insert-embed');
    setPickerOpen(true);
  };

  return (
    <div className="max-w-3xl mx-auto">
      <h1 className="text-2xl font-semibold mb-6">
        {isEditMode ? 'Edit entry' : 'New entry'}
      </h1>

      <form onSubmit={onSubmit} className="space-y-4">
        {/* Title */}
        <div>
          <label htmlFor="entry-title" className="block text-sm mb-1">
            Title
          </label>
          <input
            id="entry-title"
            {...register('title')}
            className="w-full rounded-md border border-neutral-300 dark:border-neutral-700 bg-transparent px-3 py-2 text-sm"
          />
          {errors.title && (
            <p className="text-sm text-red-500 mt-1">{errors.title.message}</p>
          )}
        </div>

        {/* Icon */}
        <div>
          <label htmlFor="entry-icon" className="block text-sm mb-1">
            Icon
          </label>
          <input
            id="entry-icon"
            {...register('icon')}
            placeholder="Emoji"
            className="w-20 rounded-md border border-neutral-300 dark:border-neutral-700 bg-transparent px-3 py-2 text-sm"
          />
        </div>

        {/* Type */}
        <div>
          <label htmlFor="entry-type" className="block text-sm mb-1">
            Type
          </label>
          <select
            id="entry-type"
            {...register('entryType')}
            className="w-full rounded-md border border-neutral-300 dark:border-neutral-700 bg-transparent px-3 py-2 text-sm"
          >
            <option value="">Select a type</option>
            {entryTypes.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
          {errors.entryType && (
            <p className="text-sm text-red-500 mt-1">{errors.entryType.message}</p>
          )}
        </div>

        {/* Category */}
        <div>
          <label htmlFor="entry-category" className="block text-sm mb-1">
            Category
          </label>
          <EntryCategoryPicker
            id="entry-category"
            universeId={uid!}
            value={categoryId}
            onChange={setCategoryId}
          />
        </div>

        {/* Summary */}
        <div>
          <label htmlFor="entry-summary" className="block text-sm mb-1">
            Summary
          </label>
          <textarea
            id="entry-summary"
            rows={2}
            {...register('summary')}
            className="w-full rounded-md border border-neutral-300 dark:border-neutral-700 bg-transparent px-3 py-2 text-sm"
          />
        </div>

        {/* Body (Markdown) + Insert image (D-05) */}
        <div>
          <div className="flex items-center justify-between mb-1">
            <label htmlFor="entry-body" className="block text-sm">
              Body (Markdown)
            </label>
            <button
              type="button"
              onClick={() => {
                setAssetReplacementSelection(null);
                setPickerMode('insert-embed');
                setPickerOpen(true);
              }}
              className="text-xs text-[color:var(--color-accent)] hover:underline"
            >
              Insert image
            </button>
          </div>
          <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_18rem]">
            <MarkdownAuthoringEditor
              ref={markdownEditorRef}
              value={watchedBody}
              onChange={(markdown) => setValue('body', markdown, { shouldDirty: true, shouldValidate: true })}
              universeId={uid ?? ''}
              entryId={entryId}
              disabled={isPending}
            />
            <aside className="space-y-3">
              <details open className="rounded-md border border-neutral-200 bg-white p-3 dark:border-neutral-800 dark:bg-neutral-900">
                <summary className="cursor-pointer text-sm font-medium text-neutral-900 dark:text-neutral-100">
                  Outline
                </summary>
                <div className="mt-3">
                  <MarkdownOutline markdown={watchedBody} onNavigate={handleOutlineNavigate} />
                </div>
              </details>
              <details open className="rounded-md border border-neutral-200 bg-white p-3 dark:border-neutral-800 dark:bg-neutral-900">
                <summary className="cursor-pointer text-sm font-medium text-neutral-900 dark:text-neutral-100">
                  Backlinks &amp; Recovery
                </summary>
                <div className="mt-3">
                  <MarkdownBacklinks
                    universeId={uid ?? ''}
                    backlinks={existingEntry?.backlinks ?? []}
                    draftMarkdown={watchedBody}
                    savedMarkdown={existingEntry?.body ?? ''}
                    savedAssetUrls={existingEntry?.assetUrls ?? {}}
                    entries={allEntries}
                    onRevealSelection={revealMarkdownSelection}
                    onReplaceAsset={handleReplaceAsset}
                  />
                </div>
              </details>
            </aside>
          </div>
        </div>

        {/* Hero (Content-Forward Views §5, Task 10) — the editor previews exactly what
            EntryDetail's hero will render, so the author sees the result before saving.
            It renders the SAME EntryHero shell the detail page does, which is what stops
            the height model (absolute visual layer, in-flow children) from drifting
            between the two surfaces — a drift whose failure mode is silent and visual.

            The cover buttons are always visible rather than hover-revealed: this is a
            form, not a display surface, so the ONLY way to attach/replace/remove a cover
            should not depend on a mouse hovering the hero — that would need extra
            focus-visible plumbing to stay keyboard-reachable for no benefit here.
            They sit in the shell's in-flow slot, so an onError'd cover (signed URLs
            expire) can never collapse the box and take the affordance with it. */}
        <div>
          <label className="block text-sm mb-1">Cover image</label>
          <EntryHero
            testId="editor-hero"
            // The editor's draft carries only coverImageId — there is no signed cover URL
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
                    className="text-xs rounded-md border border-white/40 bg-black/40 text-white px-3 py-1.5 backdrop-blur hover:bg-black/60"
                  >
                    Change cover
                  </button>
                  <button
                    type="button"
                    onClick={() => setCoverImageId(null)}
                    className="text-xs rounded-md border border-white/40 bg-black/40 text-red-300 px-3 py-1.5 backdrop-blur hover:bg-black/60"
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
                  className="text-sm rounded-md border border-neutral-300 dark:border-neutral-700 px-3 py-1.5 hover:bg-neutral-50 dark:hover:bg-neutral-800"
                >
                  Set cover image
                </button>
              )}
            </div>
          </EntryHero>
        </div>

        {/* Tags */}
        <div>
          <label className="block text-sm mb-1">Tags</label>
          <div className="rounded-md border border-neutral-300 dark:border-neutral-700 px-3 py-2">
            <TagInput value={tags} onChange={setTags} />
          </div>
        </div>

        {/* Aliases (Phase 45 XREF-04 / D-09) */}
        <div>
          <label className="block text-sm mb-1">Aliases</label>
          <div className="rounded-md border border-neutral-300 dark:border-neutral-700 px-3 py-2">
            <TagInput value={aliases} onChange={setAliases} />
          </div>
        </div>

        {/* Meta */}
        <div>
          <label className="block text-sm mb-1">Details</label>
          <MetaEditor
            value={meta}
            onChange={setMeta}
            onValidityChange={setMetaValid}
            registeredFields={universe?.fieldRegistry ?? []}
            universeId={uid}
          />
        </div>

        {/* Form actions.
            Phase 29 UI-SPEC §B order (left-to-right):
              [Discard / Cancel] ... [Kebab] [Public toggle + label] [Save]
            flex-wrap on the parent lets the right cluster wrap below the
            Discard/Cancel link on narrow viewports (< 480px). */}
        <div className="flex flex-wrap justify-between items-center gap-y-2 mt-8 pt-6 border-t border-neutral-200 dark:border-neutral-800">
          <Link
            to={
              isEditMode
                ? `/universes/${uid}/entries/${entryId}`
                : `/universes/${uid}/entries`
            }
            className="text-sm text-neutral-400 hover:text-neutral-200"
          >
            {isEditMode ? 'Discard changes' : 'Cancel'}
          </Link>

          {/* Right cluster — UI-SPEC §B: [Kebab] [Public toggle + label] [Save]. */}
          <div className="flex items-center gap-3">

          {/* Kebab overflow menu — D-14 / UI-SPEC §B */}
          <DropdownMenu.Root>
            <DropdownMenu.Trigger asChild>
              <button
                type="button"
                aria-label="Entry actions"
                className="inline-flex items-center justify-center h-8 w-8 rounded-md text-neutral-500 dark:text-neutral-400 bg-transparent hover:text-neutral-900 dark:hover:text-neutral-100 hover:bg-neutral-100 dark:hover:bg-neutral-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--color-accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-white dark:focus-visible:ring-offset-neutral-900 data-[state=open]:bg-neutral-100 dark:data-[state=open]:bg-neutral-800 data-[state=open]:text-neutral-900 dark:data-[state=open]:text-neutral-100"
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
                className="min-w-[160px] rounded-md border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 p-1 shadow-lg z-50 data-[state=open]:animate-popover-in data-[state=closed]:animate-popover-out"
              >
                <DropdownMenu.Item
                  onSelect={() => setSaveAsOpen(true)}
                  className="px-3 py-2 text-sm rounded-sm cursor-pointer outline-none data-[highlighted]:bg-neutral-100 dark:data-[highlighted]:bg-neutral-800"
                >
                  Save as template…
                </DropdownMenu.Item>
              </DropdownMenu.Content>
            </DropdownMenu.Portal>
          </DropdownMenu.Root>

          {/* Phase 29 UI-SPEC §B — Public toggle group BETWEEN kebab and
              Save. Toggle + visible "Public" label, flex items-center
              gap-2. Tooltip text swaps per UI-SPEC §B states. */}
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
                  ? 'text-neutral-900 dark:text-neutral-100'
                  : 'text-neutral-500 dark:text-neutral-400'
              }`}
            >
              Public
            </span>
          </div>

          {/* Phase 36 DATA-03 — WIP/draft toggle. Independent of the Public
              toggle (T-36-06-01): its own useState + payload key, neither
              references the other. Interactive WipPill (button role="switch")
              with a visible "Mark as WIP" label. */}
          <div className="flex items-center gap-2">
            <WipPill wip={wip} onToggle={() => setWip(!wip)} />
            <span
              id={`wip-label-${entryId ?? 'new'}`}
              className={`text-sm ${
                wip
                  ? 'text-amber-600 dark:text-amber-400'
                  : 'text-neutral-500 dark:text-neutral-400'
              }`}
            >
              Mark as WIP
            </span>
          </div>

          <button
            type="submit"
            disabled={isPending || !metaValid}
            className="rounded-md bg-[color:var(--color-accent)] text-white text-sm px-3 py-1.5 disabled:opacity-50"
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

      {/* Asset picker modal — Phase 38 MEDIA-04/05 (D-05) */}
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
          // Object.entries is correct because meta is Record (NOT tuple array)
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
            // Phase 48 XREF-05 (D-10): navigate after the user sees the rewrite summary.
            if (pendingNavigationPath) {
              const dest = pendingNavigationPath;
              setPendingNavigationPath(null);
              navigate(dest, { replace: true });
            }
          }}
        />
      )}

      {/* Phase 48 XREF-05 (D-08/D-09) — rename-propagation confirm dialog.
          Only opens in edit mode when the preview returns affectedLinks > 0.
          Offers ONLY Proceed (rename + propagate) and Cancel (no write at all)
          per D-09. No "rename without propagating" option. */}
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
