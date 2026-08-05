import { useState, useEffect, useMemo } from 'react';
import { Link, useParams, useNavigate, useSearchParams } from 'react-router-dom';
import { useUniverse, useUpdateUniverse, useDeleteUniverse } from '../hooks/useUniverse';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { EntryTypesSection } from '../components/EntryTypesSection';
import { ThemeSection } from '../components/ThemeSection';
import { FieldRegistrySection } from '../components/FieldRegistrySection';
import { ShareLinksSection } from '../components/ShareLinksSection';
import { SettingsTabBar } from '../components/SettingsTabBar';
import { SyncTab } from '../components/SyncTab';
import { Toggle } from '../components/Toggle';
import { AuditHistoryTable } from '../components/AuditHistoryTable';
import { useLlmKeys } from '../hooks/useLlmKeys';
import { useListModels } from '../hooks/useAudits';
import { RECOMMENDED_CHEAP_MODEL } from '../data/pricing';
import type { ModelListingWithCoverage } from '../types/audit';

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
  // Universe theming (2026-07-10 spec) — its own tab: ThemeSection carries its
  // own Save, so nesting it inside General invited silent theme-change loss
  // when users clicked General's Save instead.
  { id: 'theme', label: 'Theme' },
  { id: 'entry-types', label: 'Entry types' },
  // Phase 36 DATA-02 — Fields tab: per-universe typed custom-field registry.
  { id: 'fields', label: 'Fields' },
  // Phase 29 D-20 / UI-SPEC §D — Share Links tab between Entry types and AI
  // Gap Auditor: a universe-level concept adjacent to configuration.
  { id: 'share-links', label: 'Share Links' },
  { id: 'ai-auditor', label: 'AI Gap Auditor' },
  { id: 'audit-history', label: 'Audit history' },
  // Plan F F-01 — Sync tab: this universe's links to remote instances, plus
  // its conflicts. Both tables are universe-scoped; the account-scoped remotes
  // they point at are managed at /settings/sync instead.
  //
  // Registering the id here is load-bearing, not cosmetic: `safeTab` below
  // falls back to `general` for any value TABS does not know, so a deep link to
  // `?tab=sync` would silently land on General.
  { id: 'sync', label: 'Sync' },
];

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

  useEffect(() => {
    if (data) {
      setName(data.name);
      setDescription(data.description);
      setAuditEnabled(data.auditEnabled);
      setAuditProvider(data.auditProvider ?? '');
      setAuditModel(data.auditModel ?? '');
    }
  }, [data]);

  // Phase 27 D-01 — live model catalog for the active provider. Hook is
  // disabled (no fetch) when provider is empty; 30-min staleTime aligns with
  // backend cache TTL.
  const { data: modelListing } = useListModels(
    auditProvider === '' ? undefined : auditProvider,
  );
  const modelOptions: ModelListingWithCoverage[] = useMemo(
    () => modelListing?.models ?? [],
    [modelListing],
  );

  // Phase 27 D-08 — default-selection fallback chain when the universe has no
  // saved auditModel yet:
  //   (1) RECOMMENDED_CHEAP_MODEL[provider] if present in the live list
  //   (2) live[0].id otherwise
  //   (3) '' (with "no models available" UI shown in place of the select)
  useEffect(() => {
    if (auditProvider === '' || auditModel !== '') return;
    if (modelOptions.length === 0) return; // nothing to pick yet; UI shows empty-state
    const recommended = RECOMMENDED_CHEAP_MODEL[auditProvider];
    const ids = modelOptions.map((m) => m.id);
    if (ids.includes(recommended)) {
      setAuditModel(recommended);
    } else {
      setAuditModel(modelOptions[0].id);
    }
  }, [auditProvider, auditModel, modelOptions]);

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

  // `modelOptions` is computed above from `useListModels()` (Phase 27 D-01).

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
            {/* Phase 30 CALENDAR-01 — Calendar entry point */}
            {id && (
              <div className="pt-4 border-t border-neutral-200 dark:border-neutral-800">
                <h2 className="text-lg font-medium mb-2">Calendar</h2>
                <p className="text-sm text-neutral-500 mb-2">
                  Define an in-world calendar so timeline positions display as dates.
                </p>
                <Link
                  to={`/universes/${id}/calendar`}
                  className="text-sm text-[color:var(--color-accent)] hover:underline"
                >
                  Manage calendar →
                </Link>
              </div>
            )}

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

        {/* ─── Theme tab ───────────────────────────────────────────── */}
        {/* Universe theming (2026-07-10 spec) — palette, accent, font,
            backdrop. Own tab: ThemeSection carries its own Save button. */}
        {safeTab === 'theme' && (
          <div>
            <ThemeSection universe={data} />
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

        {/* ─── Fields tab ──────────────────────────────────────────── */}
        {/* Phase 36 DATA-02 — typed custom-field registry editor. */}
        {safeTab === 'fields' && data && (
          <div>
            <h2 className="text-lg font-medium mb-2">Custom fields</h2>
            <p className="text-sm text-neutral-500 mb-3">
              Define typed data slots that appear in the meta editor of every entry.
              Field names are unique per universe; editing or removing a field never
              deletes the values already stored on your entries.
            </p>
            <FieldRegistrySection universe={data} />
          </div>
        )}

        {/* ─── Share Links tab ─────────────────────────────────────── */}
        {/* Phase 29 D-20 / UI-SPEC §D — per-universe share link management
            (mint via CreateShareLinkDialog, revoke inline). Global audit
            view lives at /settings/shares (Plan 07 Task 3). */}
        {safeTab === 'share-links' && id && (
          <ShareLinksSection universeId={id} />
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

            {/* Model dropdown — Phase 27 D-05/D-08 live-driven, with the
                `⚠ no pricing` suffix on entries the user's BYOK key can call
                but PRICING does not yet cover. When the live list resolves
                to empty (provider has no models at all for this key), the
                <select> is replaced by an inline "no models available"
                message (D-08 chain step 3). */}
            <label className="block text-sm mt-4 mb-1" htmlFor="model">Model</label>
            {auditProvider !== '' && modelListing !== undefined && modelOptions.length === 0 ? (
              <p
                id="model"
                role="status"
                className="text-sm text-neutral-500 dark:text-neutral-400 italic"
              >
                No models available for the selected provider.
              </p>
            ) : (
              <select
                id="model"
                value={auditModel}
                onChange={(e) => setAuditModel(e.target.value)}
                disabled={!auditEnabled || auditProvider === ''}
                className={`w-full rounded-md border border-neutral-300 dark:border-neutral-700 bg-transparent px-3 py-2 text-sm ${!auditEnabled || auditProvider === '' ? 'opacity-50 cursor-not-allowed' : ''}`}
              >
                {auditProvider === '' && <option value="">Select a provider first</option>}
                {auditProvider !== '' && modelOptions.length === 0 && (
                  <option value="">Loading…</option>
                )}
                {modelOptions.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.id}{m.hasPricing ? '' : ' ⚠ no pricing'}
                  </option>
                ))}
              </select>
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

        {/* ─── Sync tab ────────────────────────────────────────────── */}
        {/* Plan F Task 3 — links, runs and (Task 4) conflicts for THIS
            universe. Gated on `id` like the Share Links tab: the hooks inside
            key their queries and their invalidations by universe id. */}
        {safeTab === 'sync' && id && <SyncTab universeId={id} />}
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
