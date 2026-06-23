import { useState, useEffect, useRef } from 'react';
import { useParams, useNavigate, Link, useLocation } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { useEntry, useCreateEntry, useUpdateEntry, useEntries } from '../hooks/useEntries';
import { useUniverse } from '../hooks/useUniverse';
import { TagInput } from '../components/TagInput';
import { MetaEditor } from '../components/MetaEditor';
import { EntryCategoryPicker } from '../components/EntryCategoryPicker';
import SaveAsTemplateDialog from '../components/SaveAsTemplateDialog';
import { Toast } from '../components/Toast';
import { Toggle } from '../components/Toggle';
import { WipPill } from '../components/WipPill';
import { AssetPickerModal } from '../components/AssetPickerModal';
import { WikilinkAutocomplete, isInsideCodeSpan } from '../components/WikilinkAutocomplete';
import { metaArrayToRecord } from '../lib/entryTemplates';
import type { Entry } from '../hooks/useEntries';
import type { EntryTemplate } from '../lib/entryTemplates';

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
  useEntries(uid ?? '');

  const [tags, setTags] = useState<string[]>([]);
  // Phase 45 XREF-04 (D-09) — alias chips placed immediately after Tags field.
  const [aliases, setAliases] = useState<string[]>([]);
  const [meta, setMeta] = useState<Record<string, string>>({});
  const [categoryId, setCategoryId] = useState<string | null>(null);
  const [metaValid, setMetaValid] = useState(true);
  const [saveAsOpen, setSaveAsOpen] = useState(false);
  const [toast, setToast] = useState<{ message: string; variant: 'success' | 'error' } | null>(null);
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
  // Ref to the body textarea for cursor-position insertion of asset:// embeds.
  const bodyTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  // Phase 47 XREF-01 — wikilink autocomplete picker state.
  // triggerStart: textarea char index of the opening `[[` (inclusive of first `[`).
  // wikilinkQuery: the text typed after `[[`, updated on each keystroke.
  const [wikilinkPickerOpen, setWikilinkPickerOpen] = useState(false);
  const [wikilinkTriggerStart, setWikilinkTriggerStart] = useState<number>(0);
  const [wikilinkQuery, setWikilinkQuery] = useState('');
  const [wikilinkActiveIndex, setWikilinkActiveIndex] = useState(0);
  const [wikilinkResultCount, setWikilinkResultCount] = useState(0);
  // CR-01: canonical insert string for the currently-highlighted row, reported up
  // by WikilinkAutocomplete from its own (authoritative) result list. The Enter
  // handler inserts this instead of re-ranking from a second subscription.
  const [wikilinkActiveInsert, setWikilinkActiveInsert] = useState<string | null>(null);
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
    return <p className="text-sm text-neutral-500">Loading...</p>;
  }

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
      await updateEntry.mutateAsync(payload);
      navigate(`/universes/${uid}/entries/${entryId}`, { replace: true });
    } else {
      const created = await createEntry.mutateAsync(payload);
      navigate(`/universes/${uid}/entries/${(created as Entry).id}`, { replace: true });
    }
  });

  const entryTypes = universe?.entryTypes ?? [];
  const isPending = createEntry.isPending || updateEntry.isPending;

  // Phase 47 XREF-01 — detect an unclosed `[[` token backward from the caret.
  // Returns the char index of the `[` that opens the `[[`, or null if not found.
  // Returns null when the cursor is inside a code span (D-11).
  function detectWikilinkTrigger(value: string, caret: number): number | null {
    // Guard: inside code span → suppress (D-11)
    if (isInsideCodeSpan(value, caret)) return null;

    const before = value.slice(0, caret);
    // Walk backward looking for `[[`. Stop on newline (treat each line independently).
    for (let i = before.length - 2; i >= 0; i--) {
      const ch = before[i];
      // Newline terminates the search — wikilinks don't span lines
      if (ch === '\n') return null;
      if (ch === '[' && before[i + 1] === '[') {
        // Found `[[` — check there's no closing `]` or `]]` between here and caret
        const between = before.slice(i + 2);
        if (between.includes(']') || between.includes('\n')) return null;
        return i;
      }
    }
    return null;
  }

  // Phase 47 XREF-01 — insert the selected wikilink text at the `[[` trigger position.
  // Reuses the nativeInputValueSetter + dispatchEvent pattern from handlePickerSelect (D-04).
  const handleWikilinkInsert = (insertText: string) => {
    const textarea = bodyTextareaRef.current;
    if (textarea) {
      const replaceStart = wikilinkTriggerStart;
      // WR-03: replace the full selection range. Using selectionStart as the end
      // drops or duplicates a non-collapsed selection; selectionEnd === selectionStart
      // when the caret is collapsed, so this is safe in the common case and correct
      // when text is selected (mirrors handlePickerSelect's embed inserter).
      const replaceEnd = textarea.selectionEnd ?? textarea.selectionStart ?? 0;
      const currentValue = textarea.value;
      const newValue =
        currentValue.slice(0, replaceStart) + insertText + currentValue.slice(replaceEnd);
      // Use react-hook-form's setValue via the native input event approach
      const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype,
        'value',
      )?.set;
      if (nativeInputValueSetter) {
        nativeInputValueSetter.call(textarea, newValue);
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
      }
      // Move cursor after the inserted wikilink
      const cursor = replaceStart + insertText.length;
      setTimeout(() => {
        // WR-06: bail if the textarea was unmounted/replaced before the timer
        // fired — avoids touching/focusing a detached node after navigation.
        if (bodyTextareaRef.current !== textarea) return;
        textarea.selectionStart = cursor;
        textarea.selectionEnd = cursor;
        textarea.focus();
      }, 0);
    }
    setWikilinkPickerOpen(false);
    setWikilinkActiveIndex(0);
    setWikilinkQuery('');
    setWikilinkActiveInsert(null);
  };

  // Phase 47 XREF-01 — keyboard handler for the body textarea when picker is open.
  const handleBodyKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (!wikilinkPickerOpen) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setWikilinkActiveIndex((i) => Math.min(i + 1, wikilinkResultCount - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setWikilinkActiveIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      // CR-01: insert exactly what the picker highlights. wikilinkActiveInsert is
      // reported up by WikilinkAutocomplete from its own result list, so it can
      // never desync from the rendered rows the way a parent-side re-rank could
      // (which silently inserted nothing while a populated list was on screen).
      if (wikilinkActiveInsert) {
        handleWikilinkInsert(wikilinkActiveInsert);
      }
    } else if (e.key === 'Escape') {
      e.preventDefault();
      setWikilinkPickerOpen(false);
      setWikilinkActiveIndex(0);
    } else if (e.key === ' ') {
      // Space closes the picker (D-12) — but does NOT prevent the space from being
      // typed. WR-01: once the query holds a pipe, the user is authoring `|display`
      // text (D-05), which commonly contains spaces (`[[Empire|the big one]]`); keep
      // the picker open so Enter can still commit the link.
      if (wikilinkQuery.includes('|')) return;
      setWikilinkPickerOpen(false);
      setWikilinkActiveIndex(0);
    }
  };

  // Phase 47 XREF-01 — onChange watcher for the body textarea.
  // Detects `[[` trigger and updates query. Composed with react-hook-form's onChange.
  const handleBodyChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const value = e.target.value;
    const caret = e.target.selectionStart ?? 0;
    const triggerIdx = detectWikilinkTrigger(value, caret);
    if (triggerIdx !== null) {
      // Extract the query text between `[[` and the caret. IN-02: detectWikilinkTrigger
      // already returns null when a `]` sits between `[[` and the caret, so the query
      // here can never contain `]` — no redundant `]]`-close check is needed.
      const query = value.slice(triggerIdx + 2, caret);
      setWikilinkTriggerStart(triggerIdx);
      setWikilinkQuery(query);
      setWikilinkPickerOpen(true);
      // Reset active index when query changes
      setWikilinkActiveIndex(0);
    } else {
      // No trigger found — close the picker
      if (wikilinkPickerOpen) {
        setWikilinkPickerOpen(false);
        setWikilinkActiveIndex(0);
      }
    }
  };

  // Phase 38 MEDIA-05: handle picker selection for both modes.
  const handlePickerSelect = (assetId: string) => {
    if (pickerMode === 'insert-embed') {
      // Insert ![alt](asset://uuid) at cursor or append to body textarea
      const textarea = bodyTextareaRef.current;
      const embed = `![image](asset://${assetId})`;
      if (textarea) {
        const start = textarea.selectionStart ?? 0;
        const end = textarea.selectionEnd ?? 0;
        const currentValue = textarea.value;
        const newValue =
          currentValue.slice(0, start) + embed + currentValue.slice(end);
        // Use react-hook-form's setValue via the native input event approach
        const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
          window.HTMLTextAreaElement.prototype,
          'value',
        )?.set;
        if (nativeInputValueSetter) {
          nativeInputValueSetter.call(textarea, newValue);
          textarea.dispatchEvent(new Event('input', { bubbles: true }));
        }
        // Move cursor after the inserted embed
        setTimeout(() => {
          textarea.selectionStart = start + embed.length;
          textarea.selectionEnd = start + embed.length;
          textarea.focus();
        }, 0);
      }
    } else {
      // set-cover mode
      setCoverImageId(assetId);
    }
    setPickerOpen(false);
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
                setPickerMode('insert-embed');
                setPickerOpen(true);
              }}
              className="text-xs text-[color:var(--color-accent)] hover:underline"
            >
              Insert image
            </button>
          </div>
          {/* position:relative parent so WikilinkAutocomplete caret-anchor span positions correctly */}
          <div style={{ position: 'relative' }}>
            <textarea
              id="entry-body"
              rows={12}
              {...register('body')}
              ref={(el) => {
                // Merge react-hook-form ref + our bodyTextareaRef
                const { ref: rhfRef } = register('body');
                if (typeof rhfRef === 'function') rhfRef(el);
                bodyTextareaRef.current = el;
              }}
              onKeyDown={handleBodyKeyDown}
              onChange={(e) => {
                // Compose with react-hook-form's onChange — call rHF first, then our handler
                const rhfOnChange = register('body').onChange;
                rhfOnChange(e);
                handleBodyChange(e);
              }}
              onBlur={(e) => {
                // Compose with react-hook-form's onBlur (validation trigger)
                const rhfOnBlur = register('body').onBlur;
                rhfOnBlur(e);
                // Close picker on blur, but use a microtask guard so a row
                // mousedown fires first (onMouseDown fires before blur)
                setTimeout(() => setWikilinkPickerOpen(false), 100);
              }}
              placeholder="Write in Markdown..."
              className="w-full rounded-md border border-neutral-300 dark:border-neutral-700 bg-transparent px-3 py-2 text-sm font-mono"
            />
            {uid && wikilinkPickerOpen && (
              <WikilinkAutocomplete
                universeId={uid}
                currentEntryId={entryId ?? null}
                query={wikilinkQuery}
                textareaRef={bodyTextareaRef}
                triggerStart={wikilinkTriggerStart}
                activeIndex={wikilinkActiveIndex}
                onActiveIndexChange={setWikilinkActiveIndex}
                onResultCountChange={setWikilinkResultCount}
                onActiveInsertChange={setWikilinkActiveInsert}
                onSelect={handleWikilinkInsert}
                onDismiss={() => {
                  setWikilinkPickerOpen(false);
                  setWikilinkActiveIndex(0);
                }}
              />
            )}
          </div>
        </div>

        {/* Cover image (D-04/D-05) */}
        <div>
          <label className="block text-sm mb-1">Cover image</label>
          {coverImageId ? (
            <div className="flex items-start gap-3">
              <img
                src={`/api/universes/${uid}/assets/${coverImageId}/thumb`}
                alt="Cover image preview"
                className="w-24 h-24 object-contain rounded border border-neutral-200 dark:border-neutral-700 bg-neutral-100 dark:bg-neutral-800"
                onError={(e) => {
                  (e.target as HTMLImageElement).style.display = 'none';
                }}
              />
              <div className="flex flex-col gap-2">
                <button
                  type="button"
                  onClick={() => {
                    setPickerMode('set-cover');
                    setPickerOpen(true);
                  }}
                  className="text-xs rounded-md border border-neutral-300 dark:border-neutral-700 px-3 py-1.5 hover:bg-neutral-50 dark:hover:bg-neutral-800"
                >
                  Change cover
                </button>
                <button
                  type="button"
                  onClick={() => setCoverImageId(null)}
                  className="text-xs text-red-500 hover:text-red-700"
                >
                  Remove cover
                </button>
              </div>
            </div>
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
          onOpenChange={setPickerOpen}
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
          onDismiss={() => setToast(null)}
        />
      )}
    </div>
  );
}
