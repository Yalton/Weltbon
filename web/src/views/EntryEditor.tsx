import { useState, useEffect, useRef } from 'react';
import { useParams, useNavigate, Link, useLocation } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { useEntry, useCreateEntry, useUpdateEntry } from '../hooks/useEntries';
import { useUniverse } from '../hooks/useUniverse';
import { TagInput } from '../components/TagInput';
import { MetaEditor } from '../components/MetaEditor';
import { EntryCategoryPicker } from '../components/EntryCategoryPicker';
import SaveAsTemplateDialog from '../components/SaveAsTemplateDialog';
import { Toast } from '../components/Toast';
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

  const [tags, setTags] = useState<string[]>([]);
  const [meta, setMeta] = useState<Record<string, string>>({});
  const [categoryId, setCategoryId] = useState<string | null>(null);
  const [metaValid, setMetaValid] = useState(true);
  const [saveAsOpen, setSaveAsOpen] = useState(false);
  const [toast, setToast] = useState<{ message: string; variant: 'success' | 'error' } | null>(null);
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
      setMeta((existingEntry.meta as Record<string, string>) ?? {});
      setCategoryId(existingEntry.categoryId ?? null);
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
      meta,
      categoryId,
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

        {/* Body (Markdown) */}
        <div>
          <label htmlFor="entry-body" className="block text-sm mb-1">
            Body (Markdown)
          </label>
          <textarea
            id="entry-body"
            rows={12}
            {...register('body')}
            placeholder="Write in Markdown..."
            className="w-full rounded-md border border-neutral-300 dark:border-neutral-700 bg-transparent px-3 py-2 text-sm font-mono"
          />
        </div>

        {/* Tags */}
        <div>
          <label className="block text-sm mb-1">Tags</label>
          <div className="rounded-md border border-neutral-300 dark:border-neutral-700 px-3 py-2">
            <TagInput value={tags} onChange={setTags} />
          </div>
        </div>

        {/* Meta */}
        <div>
          <label className="block text-sm mb-1">Details</label>
          <MetaEditor
            value={meta}
            onChange={setMeta}
            onValidityChange={setMetaValid}
          />
        </div>

        {/* Form actions */}
        <div className="flex justify-between items-center mt-8 pt-6 border-t border-neutral-200 dark:border-neutral-800">
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
      </form>

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
