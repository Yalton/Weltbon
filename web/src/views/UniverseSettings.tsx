import { useState, useEffect } from 'react';
import { Link, useParams, useNavigate, useSearchParams } from 'react-router-dom';
import * as Dialog from '@radix-ui/react-dialog';
import { useUniverse, useUpdateUniverse, useDeleteUniverse } from '../hooks/useUniverse';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { EntryTypesSection } from '../components/EntryTypesSection';
import { SettingsTabBar } from '../components/SettingsTabBar';
import { Toggle } from '../components/Toggle';
import { AuditHistoryTable } from '../components/AuditHistoryTable';
import { useLlmKeys } from '../hooks/useLlmKeys';
import { RECOMMENDED_CHEAP_MODEL } from '../data/pricing';
import { useListModels } from '../hooks/useAudits';
import type { EntryTemplate } from '../lib/entryTemplates';

/**
 * Phase 26 — UniverseSettings tabbed layout (D-09).
 *
 * URL `?tab=<id>` is the source of truth for the active tab (via SettingsTabBar
 * which writes setSearchParams on click). The five tabs are:
 *
 *   - general        — existing name/description edit + Delete universe
 *   - entry-types    — existing EntryTypesSection mount
 *   - ai-auditor     — AI Gap Auditor opt-in (Toggle + provider/model dropdowns + Save)
 *   - audit-history  — <AuditHistoryTable universeId={id} />
 *   - templates      — Phase 28 D-11/D-12: per-universe persisted entry templates CRUD
 *
 * Unknown tab values fall back to `general` (Task 1 step 8 — `safeTab`
 * derivation, never trust untrusted URL state to gate panel rendering).
 *
 * B-1 (resolved): RECOMMENDED_CHEAP_MODEL is IMPORTED from web/src/data/pricing.ts
 * (provided by Plan 09). Plan 06 does NOT modify pricing.ts.
 *
 * Server-side invariant: PATCH /universes/:id rejects auditEnabled=true with
 * null provider or model (api/src/routes/universes.ts refine). We surface that
 * error via update.error rather than duplicating validation client-side.
 */

const TABS = [
  { id: 'general', label: 'General' },
  { id: 'entry-types', label: 'Entry types' },
  { id: 'ai-auditor', label: 'AI Gap Auditor' },
  { id: 'audit-history', label: 'Audit history' },
  { id: 'templates', label: 'Templates' },
];

const ENTRY_TEMPLATE_CATEGORIES = ['Setting', 'People', 'Things', 'Time', 'Other'] as const;

type TemplateCategory = typeof ENTRY_TEMPLATE_CATEGORIES[number];

/** Blank form state for the template create/edit dialog. */
const BLANK_FORM: {
  label: string;
  entryType: string;
  category: TemplateCategory;
  body: string;
  metaFields: Array<{ key: string; value: string }>;
} = {
  label: '',
  entryType: '',
  category: 'Other',
  body: '',
  metaFields: [],
};

export function UniverseSettings() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { data, isLoading } = useUniverse(id);
  const update = useUpdateUniverse(id ?? '');
  const del = useDeleteUniverse();
  // useLlmKeys may return `data: undefined` (loading) or, in tests, a non-array
  // mock value (e.g. a Universe object from `mockResolvedValue`). Coerce to an
  // empty array defensively so `.some(...)` never throws on a non-array value.
  const { data: llmKeysRaw } = useLlmKeys();
  const llmKeys = Array.isArray(llmKeysRaw) ? llmKeysRaw : [];
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [confirmOpen, setConfirmOpen] = useState(false);

  // AI Gap Auditor local form state — hydrated from `data` on load.
  const [auditEnabled, setAuditEnabled] = useState(false);
  const [auditProvider, setAuditProvider] = useState<'anthropic' | 'openai' | ''>('');
  const [auditModel, setAuditModel] = useState<string>('');

  // Phase 27: live model catalog sourced from the /llm-keys/models endpoint
  // (D-05 badge, D-08 fallback). PRICING no longer drives the dropdown.
  const { data: modelsData } = useListModels(auditProvider !== '' ? auditProvider : undefined);

  // ─── Templates tab state ─────────────────────────────────────────────────────
  const [templateDialogOpen, setTemplateDialogOpen] = useState(false);
  const [editingTemplate, setEditingTemplate] = useState<EntryTemplate | null>(null);
  const [templateForm, setTemplateForm] = useState(BLANK_FORM);
  const [templateSaveStatus, setTemplateSaveStatus] = useState<'idle' | 'success' | 'error'>('idle');
  const [deleteTemplateId, setDeleteTemplateId] = useState<string | null>(null);

  useEffect(() => {
    if (data) {
      setName(data.name);
      setDescription(data.description);
      setAuditEnabled(data.auditEnabled);
      setAuditProvider(data.auditProvider ?? '');
      setAuditModel(data.auditModel ?? '');
    }
  }, [data]);

  // D-08 fallback chain: when provider changes and model is empty, pick:
  // (1) RECOMMENDED_CHEAP_MODEL[provider] if present in the live list
  // (2) live[0] if the list is non-empty
  // (3) leave empty (renders "no models available" message)
  useEffect(() => {
    if (auditProvider !== '' && auditModel === '') {
      const liveModels = modelsData?.models ?? [];
      const recommended = RECOMMENDED_CHEAP_MODEL[auditProvider];
      if (recommended && liveModels.some((m) => m.id === recommended)) {
        setAuditModel(recommended);
      } else if (liveModels.length > 0) {
        setAuditModel(liveModels[0].id);
      }
      // else: leave empty — select renders "no models available"
    }
  }, [auditProvider, auditModel, modelsData]);

  if (isLoading || !data) return <p className="text-sm text-neutral-500">Loading...</p>;

  const activeTab = searchParams.get('tab') ?? 'general';
  const safeTab = TABS.some((t) => t.id === activeTab) ? activeTab : 'general';

  const hasAnthropicKey = llmKeys.some((k) => k.provider === 'anthropic');
  const hasOpenAIKey = llmKeys.some((k) => k.provider === 'openai');

  const handleSave = async () => {
    const patch: {
      name?: string;
      description?: string;
      auditEnabled?: boolean;
      auditProvider?: 'anthropic' | 'openai' | null;
      auditModel?: string | null;
    } = {};
    if (name !== data.name) patch.name = name;
    if (description !== data.description) patch.description = description;
    if (auditEnabled !== data.auditEnabled) patch.auditEnabled = auditEnabled;
    const apFinal: 'anthropic' | 'openai' | null = auditProvider === '' ? null : auditProvider;
    if (apFinal !== (data.auditProvider ?? null)) patch.auditProvider = apFinal;
    const amFinal: string | null = auditModel === '' ? null : auditModel;
    if (amFinal !== (data.auditModel ?? null)) patch.auditModel = amFinal;
    if (Object.keys(patch).length === 0) return;
    await update.mutateAsync(patch);
  };

  const handleDelete = async () => {
    if (!id) return;
    await del.mutateAsync(id);
    navigate('/universes', { replace: true });
  };

  // Compute diff for AI-tab Save button disabled state.
  const aiPatchEmpty =
    auditEnabled === data.auditEnabled &&
    (auditProvider === '' ? null : auditProvider) === (data.auditProvider ?? null) &&
    (auditModel === '' ? null : auditModel) === (data.auditModel ?? null);

  // Phase 27: model options sourced from live /llm-keys/models endpoint.
  // PRICING no longer drives the dropdown; it remains ONLY for cost display.
  const liveModels = modelsData?.models ?? [];

  // ─── Template CRUD handlers ──────────────────────────────────────────────────

  const openCreateDialog = () => {
    setEditingTemplate(null);
    setTemplateForm(BLANK_FORM);
    setTemplateSaveStatus('idle');
    setTemplateDialogOpen(true);
  };

  const openEditDialog = (t: EntryTemplate) => {
    setEditingTemplate(t);
    setTemplateForm({
      label: t.label,
      entryType: t.entryType,
      category: t.category as TemplateCategory,
      body: t.body,
      metaFields: Object.entries(t.meta).map(([key, value]) => ({ key, value })),
    });
    setTemplateSaveStatus('idle');
    setTemplateDialogOpen(true);
  };

  const handleTemplateSave = async () => {
    setTemplateSaveStatus('idle');
    const meta: Record<string, string> = {};
    for (const { key, value } of templateForm.metaFields) {
      if (key.trim()) meta[key.trim()] = value;
    }
    const saved: EntryTemplate = {
      id: editingTemplate ? editingTemplate.id : `user-${crypto.randomUUID()}`,
      label: templateForm.label.trim(),
      entryType: templateForm.entryType.trim(),
      category: templateForm.category,
      body: templateForm.body,
      meta,
    };
    const existing = data.entryTemplates ?? [];
    const next = editingTemplate
      ? existing.map((t) => (t.id === saved.id ? saved : t))
      : [...existing, saved];
    try {
      await update.mutateAsync({ entryTemplates: next });
      setTemplateSaveStatus('success');
      setTemplateDialogOpen(false);
    } catch {
      setTemplateSaveStatus('error');
    }
  };

  const handleTemplateDelete = async () => {
    if (!deleteTemplateId) return;
    const next = (data.entryTemplates ?? []).filter((t) => t.id !== deleteTemplateId);
    await update.mutateAsync({ entryTemplates: next });
    setDeleteTemplateId(null);
  };

  const addMetaField = () => {
    setTemplateForm((f) => ({ ...f, metaFields: [...f.metaFields, { key: '', value: '' }] }));
  };

  const removeMetaField = (idx: number) => {
    setTemplateForm((f) => ({
      ...f,
      metaFields: f.metaFields.filter((_, i) => i !== idx),
    }));
  };

  const updateMetaField = (idx: number, field: 'key' | 'value', val: string) => {
    setTemplateForm((f) => ({
      ...f,
      metaFields: f.metaFields.map((mf, i) => (i === idx ? { ...mf, [field]: val } : mf)),
    }));
  };

  const savedTemplates = data.entryTemplates ?? [];

  return (
    <div className="max-w-2xl mx-auto">
      <h1 className="text-2xl font-semibold mb-6">{data.name}</h1>
      <SettingsTabBar tabs={TABS} defaultTab="general" />
      <div
        role="tabpanel"
        id={`panel-${safeTab}`}
        aria-labelledby={`tab-${safeTab}`}
      >
        {/* ─── General tab ─────────────────────────────────────────── */}
        {safeTab === 'general' && (
          <div className="space-y-6">
            <div>
              <label className="block text-sm mb-1" htmlFor="name">Name</label>
              <input
                id="name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="w-full rounded-md border border-neutral-300 dark:border-neutral-700 bg-transparent px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label className="block text-sm mb-1" htmlFor="description">Description</label>
              <textarea
                id="description"
                rows={4}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                className="w-full rounded-md border border-neutral-300 dark:border-neutral-700 bg-transparent px-3 py-2 text-sm"
              />
            </div>
            <div className="flex items-center justify-between pt-4 border-t border-neutral-200 dark:border-neutral-800">
              <button
                type="button"
                onClick={handleSave}
                disabled={update.isPending}
                className="rounded-md bg-[color:var(--color-accent)] text-white text-sm px-3 py-1.5 disabled:opacity-50"
              >
                {update.isPending ? 'Saving...' : 'Save'}
              </button>
              <button
                type="button"
                onClick={() => setConfirmOpen(true)}
                className="rounded-md bg-red-600 text-white text-sm px-3 py-1.5"
              >
                Delete universe
              </button>
            </div>
          </div>
        )}

        {/* ─── Entry types tab ─────────────────────────────────────── */}
        {safeTab === 'entry-types' && (
          <div>
            <h2 className="text-lg font-medium mb-2">Entry types</h2>
            <p className="text-sm text-neutral-500 mb-3">
              The default types ship with every universe. Add custom types or remove ones you don&rsquo;t need.
              Removing a type used by entries will prompt for a fallback.
            </p>
            <EntryTypesSection universe={data} />
          </div>
        )}

        {/* ─── AI Gap Auditor tab ──────────────────────────────────── */}
        {safeTab === 'ai-auditor' && (
          <div>
            <h2 className="text-lg font-semibold mb-4">AI Gap Auditor</h2>

            <div className="flex items-center gap-3 mt-4">
              <Toggle
                checked={auditEnabled}
                onChange={setAuditEnabled}
                labelId="ai-toggle-label"
              />
              <span id="ai-toggle-label" className="text-sm">
                Enable AI Gap Auditor
              </span>
            </div>
            <p className="text-sm text-neutral-600 dark:text-neutral-400 mt-2">
              {auditEnabled
                ? 'On — you can trigger audits from this universe and its entries.'
                : 'Off — no LLM calls will be made for this universe.'}
            </p>

            {/* Provider dropdown */}
            <label className="block text-sm mt-6 mb-1" htmlFor="provider">Provider</label>
            <select
              id="provider"
              value={auditProvider}
              onChange={(e) => {
                const next = e.target.value as '' | 'anthropic' | 'openai';
                setAuditProvider(next);
                // Reset model when provider changes — useEffect will populate default.
                setAuditModel('');
              }}
              disabled={!auditEnabled}
              className={`w-full rounded-md border border-neutral-300 dark:border-neutral-700 bg-transparent px-3 py-2 text-sm ${!auditEnabled ? 'opacity-50 cursor-not-allowed' : ''}`}
            >
              <option value="">Select provider</option>
              <option value="anthropic" disabled={!hasAnthropicKey}>
                Anthropic{!hasAnthropicKey ? ' (no key configured)' : ''}
              </option>
              <option value="openai" disabled={!hasOpenAIKey}>
                OpenAI{!hasOpenAIKey ? ' (no key configured)' : ''}
              </option>
            </select>

            {/* Add key inline help when selected provider has no key */}
            {auditProvider === 'anthropic' && !hasAnthropicKey && (
              <p className="text-xs text-amber-600 dark:text-amber-400 mt-1">
                Add an Anthropic key in Settings → LLM keys{' '}
                <Link to="/settings/llm" className="underline">Add key →</Link>
              </p>
            )}
            {auditProvider === 'openai' && !hasOpenAIKey && (
              <p className="text-xs text-amber-600 dark:text-amber-400 mt-1">
                Add an OpenAI key in Settings → LLM keys{' '}
                <Link to="/settings/llm" className="underline">Add key →</Link>
              </p>
            )}

            {/* Model dropdown — Phase 27: sources from live /llm-keys/models */}
            <label className="block text-sm mt-4 mb-1" htmlFor="model">Model</label>
            <select
              id="model"
              value={auditModel}
              onChange={(e) => setAuditModel(e.target.value)}
              disabled={!auditEnabled || auditProvider === ''}
              className={`w-full rounded-md border border-neutral-300 dark:border-neutral-700 bg-transparent px-3 py-2 text-sm ${!auditEnabled || auditProvider === '' ? 'opacity-50 cursor-not-allowed' : ''}`}
            >
              {auditProvider === '' && <option value="">Select a provider first</option>}
              {auditProvider !== '' && liveModels.length === 0 && (
                <option value="">No models available</option>
              )}
              {auditProvider !== '' && liveModels.length > 0 && (
                <option value="">Select model</option>
              )}
              {liveModels.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.id}{m.hasPricing === false ? ' ⚠ no pricing' : ''}
                </option>
              ))}
            </select>
            {/* D-05: amber chip shown below dropdown when selected model has no pricing */}
            {auditModel !== '' && liveModels.some((m) => m.id === auditModel && !m.hasPricing) && (
              <span
                className="mt-1 inline-flex items-center gap-2 text-xs text-amber-700 dark:text-amber-400 bg-amber-50 dark:bg-amber-950/30 border border-amber-300 dark:border-amber-800 rounded px-2 py-1"
                aria-label="This model has no published pricing. Audit runs will be marked as cost unknown."
              >
                ⚠ no pricing — runs will be marked as cost unknown
              </span>
            )}

            <div className="mt-6 flex items-center gap-3">
              <button
                type="button"
                onClick={handleSave}
                disabled={update.isPending || aiPatchEmpty}
                className="rounded-md border border-neutral-300 dark:border-neutral-700 text-sm px-3 py-1.5 disabled:opacity-50 disabled:cursor-not-allowed hover:bg-neutral-50 dark:hover:bg-neutral-800"
              >
                Save
              </button>
              {update.isPending && (
                <span className="text-xs text-neutral-500">Saving…</span>
              )}
              {update.error && (
                <span className="text-xs text-red-600 dark:text-red-400">
                  {(update.error as Error).message}
                </span>
              )}
            </div>
          </div>
        )}

        {/* ─── Audit history tab ───────────────────────────────────── */}
        {safeTab === 'audit-history' && (
          <div>
            <AuditHistoryTable universeId={id!} />
          </div>
        )}

        {/* ─── Templates tab ───────────────────────────────────────── */}
        {safeTab === 'templates' && (
          <div>
            <div className="flex items-start justify-between mb-2">
              <div>
                <h2 className="text-lg font-medium">Entry templates</h2>
                <p className="text-sm text-neutral-500 mt-1">
                  Save custom templates to reuse when creating entries. Built-in templates always remain available.
                </p>
              </div>
              <button
                type="button"
                onClick={openCreateDialog}
                className="ml-4 shrink-0 rounded-md bg-[color:var(--color-accent)] text-white text-sm px-3 py-1.5 disabled:opacity-50"
              >
                Save template
              </button>
            </div>

            {savedTemplates.length === 0 ? (
              <div className="mt-6 rounded-md border border-dashed border-neutral-300 dark:border-neutral-700 p-8 text-center">
                <p className="text-sm font-medium text-neutral-600 dark:text-neutral-400">No saved templates</p>
                <p className="text-xs text-neutral-500 mt-1">
                  Save a template to quickly scaffold new entries with pre-filled fields.
                </p>
              </div>
            ) : (
              <div className="mt-4 grid grid-cols-2 gap-2">
                {savedTemplates.map((t) => (
                  <div
                    key={t.id}
                    className="relative group rounded-md border border-neutral-200 dark:border-neutral-800 p-3"
                  >
                    <div className="font-medium text-sm">{t.label}</div>
                    {t.entryType && (
                      <div className="text-xs text-neutral-500 mt-0.5">type: {t.entryType}</div>
                    )}
                    <div className="text-xs text-neutral-500 mt-0.5">{t.category}</div>
                    {/* Hover action buttons */}
                    <button
                      type="button"
                      onClick={() => openEditDialog(t)}
                      className="absolute top-2 right-8 opacity-0 group-hover:opacity-100 transition-opacity text-neutral-400 hover:text-neutral-600 text-xs"
                      aria-label="Edit template"
                    >
                      ✏
                    </button>
                    <button
                      type="button"
                      onClick={() => setDeleteTemplateId(t.id)}
                      className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 transition-opacity text-neutral-400 hover:text-red-500 text-xs"
                      aria-label="Delete template"
                    >
                      ✕
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* ─── Universe delete confirm dialog ──────────────────────── */}
      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title={`Delete "${data.name}"?`}
        body="This permanently removes the universe and everything inside it. This cannot be undone."
        confirmPhrase={data.name}
        confirmLabel="Delete"
        destructive
        onConfirm={handleDelete}
      />

      {/* ─── Template delete confirm dialog ──────────────────────── */}
      <ConfirmDialog
        open={deleteTemplateId !== null}
        onOpenChange={(open) => { if (!open) setDeleteTemplateId(null); }}
        title="Delete this template?"
        body="This removes the template from your universe. Built-in templates are unaffected."
        confirmLabel="Delete template"
        destructive
        onConfirm={handleTemplateDelete}
      />

      {/* ─── Template create/edit dialog ─────────────────────────── */}
      <Dialog.Root open={templateDialogOpen} onOpenChange={(open) => {
        setTemplateDialogOpen(open);
        if (!open) setTemplateSaveStatus('idle');
      }}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 bg-black/50 z-40 data-[state=open]:animate-overlay-in data-[state=closed]:animate-overlay-out" />
          <Dialog.Content className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-full max-w-lg max-h-[85vh] overflow-y-auto bg-white dark:bg-neutral-900 rounded-md p-6 z-50 border border-neutral-200 dark:border-neutral-800 data-[state=open]:animate-dialog-in data-[state=closed]:animate-dialog-out focus:outline-none">
            <Dialog.Title className="text-lg font-semibold">
              {editingTemplate ? 'Edit template' : 'New template'}
            </Dialog.Title>
            <Dialog.Description className="text-sm text-neutral-500 mt-1">
              {editingTemplate
                ? 'Update this template. Changes apply the next time you use it to create an entry.'
                : 'Define a reusable template for new entries.'}
            </Dialog.Description>

            <div className="mt-4 space-y-4">
              {/* Name */}
              <div>
                <label className="block text-sm mb-1" htmlFor="tpl-name">Name</label>
                <input
                  id="tpl-name"
                  value={templateForm.label}
                  onChange={(e) => setTemplateForm((f) => ({ ...f, label: e.target.value }))}
                  placeholder="e.g. Named Character"
                  className="w-full rounded-md border border-neutral-300 dark:border-neutral-700 bg-transparent px-3 py-1.5 text-sm outline-none focus:border-[color:var(--color-accent)]"
                />
              </div>

              {/* Entry type */}
              <div>
                <label className="block text-sm mb-1" htmlFor="tpl-entry-type">Entry type</label>
                <input
                  id="tpl-entry-type"
                  value={templateForm.entryType}
                  onChange={(e) => setTemplateForm((f) => ({ ...f, entryType: e.target.value }))}
                  placeholder="e.g. entity"
                  className="w-full rounded-md border border-neutral-300 dark:border-neutral-700 bg-transparent px-3 py-1.5 text-sm outline-none focus:border-[color:var(--color-accent)]"
                />
              </div>

              {/* Category */}
              <div>
                <label className="block text-sm mb-1" htmlFor="tpl-category">Category</label>
                <select
                  id="tpl-category"
                  value={templateForm.category}
                  onChange={(e) => setTemplateForm((f) => ({ ...f, category: e.target.value as TemplateCategory }))}
                  className="w-full rounded-md border border-neutral-300 dark:border-neutral-700 bg-transparent px-3 py-1.5 text-sm outline-none focus:border-[color:var(--color-accent)]"
                >
                  {ENTRY_TEMPLATE_CATEGORIES.map((cat) => (
                    <option key={cat} value={cat}>{cat}</option>
                  ))}
                </select>
              </div>

              {/* Body skeleton */}
              <div>
                <label className="block text-sm mb-1" htmlFor="tpl-body">Body skeleton (optional)</label>
                <textarea
                  id="tpl-body"
                  rows={4}
                  value={templateForm.body}
                  onChange={(e) => setTemplateForm((f) => ({ ...f, body: e.target.value }))}
                  placeholder="## Section&#10;&#10;## Another section"
                  className="w-full rounded-md border border-neutral-300 dark:border-neutral-700 bg-transparent px-3 py-1.5 text-sm outline-none focus:border-[color:var(--color-accent)]"
                />
              </div>

              {/* Default fields */}
              <div>
                <label className="block text-sm mb-1">Default fields (optional)</label>
                {templateForm.metaFields.map((mf, i) => (
                  <div key={i} className="flex gap-2 mb-2">
                    <input
                      value={mf.key}
                      onChange={(e) => updateMetaField(i, 'key', e.target.value)}
                      placeholder="Field name"
                      className="flex-1 rounded-md border border-neutral-300 dark:border-neutral-700 bg-transparent px-3 py-1.5 text-sm outline-none focus:border-[color:var(--color-accent)]"
                    />
                    <input
                      value={mf.value}
                      onChange={(e) => updateMetaField(i, 'value', e.target.value)}
                      placeholder="Default value"
                      className="flex-1 rounded-md border border-neutral-300 dark:border-neutral-700 bg-transparent px-3 py-1.5 text-sm outline-none focus:border-[color:var(--color-accent)]"
                    />
                    <button
                      type="button"
                      onClick={() => removeMetaField(i)}
                      className="text-neutral-400 hover:text-red-500 text-sm px-1"
                      aria-label="Remove field"
                    >
                      ✕
                    </button>
                  </div>
                ))}
                <button
                  type="button"
                  onClick={addMetaField}
                  className="text-xs text-[color:var(--color-accent)] hover:underline"
                >
                  + Add field
                </button>
              </div>
            </div>

            <div className="mt-6 flex items-center gap-3">
              <button
                type="button"
                onClick={handleTemplateSave}
                disabled={update.isPending || !templateForm.label.trim()}
                className="rounded-md bg-[color:var(--color-accent)] text-white text-sm px-3 py-1.5 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {update.isPending ? 'Saving...' : 'Save template'}
              </button>
              <Dialog.Close className="text-sm text-neutral-500 hover:text-neutral-700 px-2 py-1">
                Cancel
              </Dialog.Close>
            </div>

            {/* Inline feedback */}
            {templateSaveStatus === 'success' && (
              <p className="text-xs text-green-600 dark:text-green-400 mt-2">Template saved.</p>
            )}
            {templateSaveStatus === 'error' && (
              <p className="text-xs text-red-600 dark:text-red-400 mt-2">Couldn&rsquo;t save template. Try again.</p>
            )}
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  );
}
