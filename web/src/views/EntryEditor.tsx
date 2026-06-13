import { useState, useEffect } from 'react';
import { useParams, useNavigate, Link, useLocation } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useEntry, useCreateEntry, useUpdateEntry } from '../hooks/useEntries';
import { useUniverse } from '../hooks/useUniverse';
import { TagInput } from '../components/TagInput';
import { MetaEditor } from '../components/MetaEditor';
import { EntryCategoryPicker } from '../components/EntryCategoryPicker';
import { Toggle } from '../components/Toggle';
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
  // Phase 29 DATA-03: WIP toggle state.
  const [wip, setWip] = useState(false);

  const {
    register,
    handleSubmit,
    reset,
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
      // Phase 29 DATA-03: restore wip flag from existing entry.
      setWip((existingEntry as Entry & { wip?: boolean }).wip ?? false);
      return;
    }
    // Create mode: optionally pre-fill from template state passed via
    // location.state (set by TemplatePicker on /entries/new navigation).
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
      setMeta(template.meta);
      setTags([]);
      setCategoryId(null);
    }
    // No template state: useForm() defaultValues apply (empty form).
    // Note: depending on universe?.entryTypes too so the native <select>
    // value is re-applied once options are mounted (race avoidance).
  }, [isEditMode, existingEntry, reset, location.state, universe?.entryTypes]);

  if (isEditMode && entryLoading) {
    return <p className="text-sm text-neutral-500">Loading...</p>;
  }

  const onSubmit = handleSubmit(async (values) => {
    const payload = {
      title: values.title,
      entryType: values.entryType,
      summary: values.summary,
      body: values.body,
      icon: values.icon,
      tags,
      meta,
      categoryId,
      // Phase 29 DATA-03: persist wip flag via Plan 01 PATCH/POST support.
      wip,
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

        {/* WIP toggle — Phase 29 DATA-03; placed below Title, above Icon/Body/Meta */}
        <div className="flex items-center gap-3">
          <div className="flex flex-col">
            <span id="wip-toggle-label" className="text-sm">Mark as WIP</span>
            <span className="text-xs text-neutral-500">Flag this entry as a work in progress.</span>
          </div>
          <Toggle
            checked={wip}
            onChange={setWip}
            labelId="wip-toggle-label"
          />
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
            registeredFields={universe?.fieldRegistry ?? []}
            universeId={uid}
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
    </div>
  );
}
