import { useState, useEffect } from 'react';
import { Link, useParams, useNavigate, useSearchParams } from 'react-router-dom';
import { useUniverse, useUpdateUniverse, useDeleteUniverse } from '../hooks/useUniverse';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { EntryTypesSection } from '../components/EntryTypesSection';
import { SettingsTabBar } from '../components/SettingsTabBar';
import { Toggle } from '../components/Toggle';
import { AuditHistoryTable } from '../components/AuditHistoryTable';
import { useLlmKeys } from '../hooks/useLlmKeys';
import { PRICING, RECOMMENDED_CHEAP_MODEL } from '../data/pricing';

/**
 * Phase 26 — UniverseSettings tabbed layout (D-09).
 *
 * URL `?tab=<id>` is the source of truth for the active tab (via SettingsTabBar
 * which writes setSearchParams on click). The four tabs are:
 *
 *   - general        — existing name/description edit + Delete universe
 *   - entry-types    — existing EntryTypesSection mount
 *   - ai-auditor     — AI Gap Auditor opt-in (Toggle + provider/model dropdowns + Save)
 *   - audit-history  — <AuditHistoryTable universeId={id} />
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
];

export function UniverseSettings() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { data, isLoading } = useUniverse(id);
  const update = useUpdateUniverse(id ?? '');
  const del = useDeleteUniverse();
  const { data: llmKeys = [] } = useLlmKeys();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [confirmOpen, setConfirmOpen] = useState(false);

  // AI Gap Auditor local form state — hydrated from `data` on load.
  const [auditEnabled, setAuditEnabled] = useState(false);
  const [auditProvider, setAuditProvider] = useState<'anthropic' | 'openai' | ''>('');
  const [auditModel, setAuditModel] = useState<string>('');

  useEffect(() => {
    if (data) {
      setName(data.name);
      setDescription(data.description);
      setAuditEnabled(data.auditEnabled);
      setAuditProvider(data.auditProvider ?? '');
      setAuditModel(data.auditModel ?? '');
    }
  }, [data]);

  // When provider changes and model is empty, default to RECOMMENDED_CHEAP_MODEL[provider].
  useEffect(() => {
    if (auditProvider !== '' && auditModel === '') {
      setAuditModel(RECOMMENDED_CHEAP_MODEL[auditProvider]);
    }
  }, [auditProvider, auditModel]);

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

  // Model options for the currently-selected provider.
  const modelOptions =
    auditProvider === '' ? [] : Object.keys(PRICING[auditProvider] ?? {});

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

            {/* Model dropdown */}
            <label className="block text-sm mt-4 mb-1" htmlFor="model">Model</label>
            <select
              id="model"
              value={auditModel}
              onChange={(e) => setAuditModel(e.target.value)}
              disabled={!auditEnabled || auditProvider === ''}
              className={`w-full rounded-md border border-neutral-300 dark:border-neutral-700 bg-transparent px-3 py-2 text-sm ${!auditEnabled || auditProvider === '' ? 'opacity-50 cursor-not-allowed' : ''}`}
            >
              {auditProvider === '' && <option value="">Select a provider first</option>}
              {auditProvider !== '' && <option value="">Select model</option>}
              {modelOptions.map((m) => (
                <option key={m} value={m}>{m}</option>
              ))}
            </select>

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
      </div>

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
    </div>
  );
}
