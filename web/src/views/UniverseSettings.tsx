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
import { useSharedLlmGrants } from '../hooks/useLlmShares';
import { useListModels } from '../hooks/useAudits';
import { useInstanceConfig } from '../hooks/useInstanceConfig';
import { useLlmConnection } from '../hooks/useLlmConnection';
import { RECOMMENDED_CHEAP_MODEL } from '../data/pricing';
import type { ModelListingWithCoverage } from '../types/audit';
import { Loading } from '../components/ui/Loading';

/**
 *
 * URL `?tab=<id>` is the source of truth for the active tab (via SettingsTabBar
 * which writes setSearchParams on click). The four tabs are:
 *
 * - general — existing name/description edit + Delete universe
 * - entry-types — existing EntryTypesSection mount
 * - ai-auditor — AI Gap Auditor opt-in (Toggle + provider/model dropdowns + Save)
 * - audit-history — <AuditHistoryTable universeId={id} />
 *
 * derivation, never trust untrusted URL state to gate panel rendering).
 *
 * B-1 (resolved): RECOMMENDED_CHEAP_MODEL is IMPORTED from web/src/data/pricing.ts
 *
 * Server-side invariant: PATCH /universes/:id rejects auditEnabled=true with
 * null provider or model (api/src/routes/universes.ts refine). We surface that
 * error via update.error rather than duplicating validation client-side.
 */


function providerOptionSuffix(hasKey: boolean, consented: boolean, unconsented: boolean): string {
  if (hasKey) return '';
  if (consented) return ' (administrator-managed)';
  if (unconsented) return ' (requires Settings consent)';
  return ' (no key configured)';
}

const TABS = [
  { id: 'general', label: 'General' },
  // Universe theming (2026-07-10 spec) — its own tab: ThemeSection carries its
  // own Save, so nesting it inside General invited silent theme-change loss
  { id: 'theme', label: 'Theme' },
  { id: 'entry-types', label: 'Entry types' },
  { id: 'fields', label: 'Fields' },
  // Gap Auditor: a universe-level concept adjacent to configuration.
  { id: 'share-links', label: 'Share Links' },
  { id: 'ai-auditor', label: 'AI Gap Auditor' },
  { id: 'audit-history', label: 'Audit history' },

  // its conflicts. Both tables are universe-scoped; the account-scoped remotes
  // Registering the id here is load-bearing, not cosmetic: `safeTab` below
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
  // empty array defensively so `.some(...)` never throws on a non-array value.
  const { data: llmKeysRaw } = useLlmKeys();
  const llmKeys = Array.isArray(llmKeysRaw) ? llmKeysRaw : [];
  const { data: sharedGrantsRaw } = useSharedLlmGrants();
  const sharedGrants = Array.isArray(sharedGrantsRaw?.grants) ? sharedGrantsRaw.grants : [];
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [confirmOpen, setConfirmOpen] = useState(false);

  const [auditEnabled, setAuditEnabled] = useState(false);
  const [auditProvider, setAuditProvider] = useState<'anthropic' | 'openai' | 'ollama' | ''>('');
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

  const { localMode } = useInstanceConfig();
  const isLocal = localMode === true;
  // Desktop-only, so only fetched when it could possibly matter — mirrors
  const { data: ollamaConnection } = useLlmConnection('ollama', { enabled: isLocal });
  const hasOllamaConnection = ollamaConnection !== undefined;

  const hasAnthropicKey = llmKeys.some((k) => k.provider === 'anthropic');
  const hasOpenAIKey = llmKeys.some((k) => k.provider === 'openai');

  // provider-option JSX and the model-probe gate below share one source of
  const hasConsentedSharedProvider = new Set(
    sharedGrants.filter((grant) => grant.consentedAt !== null).map((grant) => grant.provider),
  );
  const hasUnconsentedSharedProvider = new Set(
    sharedGrants.filter((grant) => grant.consentedAt === null).map((grant) => grant.provider),
  );

  // disabled (no fetch) when provider is empty; 30-min staleTime aligns with
  const canProbeModels =
    auditProvider === 'ollama' ||
    (auditProvider === 'anthropic' && (hasAnthropicKey || hasConsentedSharedProvider.has('anthropic'))) ||
    (auditProvider === 'openai' && (hasOpenAIKey || hasConsentedSharedProvider.has('openai')));
  const { data: modelListing } = useListModels(
    auditProvider !== '' && canProbeModels ? auditProvider : undefined,
  );
  const modelOptions: ModelListingWithCoverage[] = useMemo(
    () => modelListing?.models ?? [],
    [modelListing],
  );

  useEffect(() => {
    if (auditProvider === '' || auditModel !== '') return;
    if (modelOptions.length === 0) return; // nothing to pick yet; UI shows empty-state
    const recommended = RECOMMENDED_CHEAP_MODEL[auditProvider];
    const ids = modelOptions.map((m) => m.id);
    if (recommended !== undefined && ids.includes(recommended)) {
      setAuditModel(recommended);
    } else {
      setAuditModel(modelOptions[0].id);
    }
  }, [auditProvider, auditModel, modelOptions]);

  if (isLoading || !data) return <Loading />;

  const activeTab = searchParams.get('tab') ?? 'general';
  const safeTab = TABS.some((t) => t.id === activeTab) ? activeTab : 'general';

  const handleSave = async () => {
    const patch: {
      name?: string;
      description?: string;
      auditEnabled?: boolean;
      auditProvider?: 'anthropic' | 'openai' | 'ollama' | null;
      auditModel?: string | null;
    } = {};
    if (name !== data.name) patch.name = name;
    if (description !== data.description) patch.description = description;
    if (auditEnabled !== data.auditEnabled) patch.auditEnabled = auditEnabled;
    const apFinal: 'anthropic' | 'openai' | 'ollama' | null = auditProvider === '' ? null : auditProvider;
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
                className="w-full rounded-md border border-line-strong bg-transparent px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label className="block text-sm mb-1" htmlFor="description">Description</label>
              <textarea
                id="description"
                rows={4}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                className="w-full rounded-md border border-line-strong bg-transparent px-3 py-2 text-sm"
              />
            </div>

            {id && (
              <div className="pt-4 border-t border-line">
                <h2 className="text-lg font-medium mb-2">Calendar</h2>
                <p className="text-sm text-ink-muted mb-2">
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

            <div className="flex items-center justify-between pt-4 border-t border-line">
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
            <p className="text-sm text-ink-muted mb-3">
              The default types ship with every universe. Add custom types or remove ones you don&rsquo;t need.
              Removing a type used by entries will prompt for a fallback.
            </p>
            <EntryTypesSection universe={data} />
          </div>
        )}

        {/* ─── Fields tab ──────────────────────────────────────────── */}

        {safeTab === 'fields' && data && (
          <div>
            <h2 className="text-lg font-medium mb-2">Custom fields</h2>
            <p className="text-sm text-ink-muted mb-3">
              Define typed data slots that appear in the meta editor of every entry.
              Field names are unique per universe; editing or removing a field never
              deletes the values already stored on your entries.
            </p>
            <FieldRegistrySection universe={data} />
          </div>
        )}

        {/* ─── Share Links tab ─────────────────────────────────────── */}

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
            <p className="text-sm text-ink-secondary mt-2">
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
                const next = e.target.value as '' | 'anthropic' | 'openai' | 'ollama';
                setAuditProvider(next);
                setAuditModel('');
              }}
              disabled={!auditEnabled}
              className={`w-full rounded-md border border-line-strong bg-transparent px-3 py-2 text-sm ${!auditEnabled ? 'opacity-50 cursor-not-allowed' : ''}`}
            >
              <option value="">Select provider</option>

              <option
                value="anthropic"
                disabled={!hasAnthropicKey && !hasConsentedSharedProvider.has('anthropic')}
              >
                Anthropic{providerOptionSuffix(hasAnthropicKey, hasConsentedSharedProvider.has('anthropic'), hasUnconsentedSharedProvider.has('anthropic'))}
              </option>
              <option
                value="openai"
                disabled={!hasOpenAIKey && !hasConsentedSharedProvider.has('openai')}
              >
                OpenAI{providerOptionSuffix(hasOpenAIKey, hasConsentedSharedProvider.has('openai'), hasUnconsentedSharedProvider.has('openai'))}
              </option>

              {isLocal && (
                <option value="ollama" disabled={!hasOllamaConnection}>
                  Ollama{!hasOllamaConnection ? ' (no connection configured)' : ''}
                </option>
              )}
            </select>


            {hasUnconsentedSharedProvider.has('anthropic') && (
              <p className="text-xs text-amber-600 dark:text-amber-400 mt-1">
                An administrator shared an Anthropic connection with you — review consent in Settings → LLM keys{' '}
                <Link to="/settings/llm" className="underline">Review →</Link>
              </p>
            )}
            {hasUnconsentedSharedProvider.has('openai') && (
              <p className="text-xs text-amber-600 dark:text-amber-400 mt-1">
                An administrator shared an OpenAI connection with you — review consent in Settings → LLM keys{' '}
                <Link to="/settings/llm" className="underline">Review →</Link>
              </p>
            )}

            {/* Add key inline help when the SELECTED provider has neither a
                personal key nor any shared grant at all (consented or not —
                an unconsented one is already covered by the block above,
                and "Add key" would be the wrong instruction for it: the
                credential already exists, it's an administrator's, and the
                fix is accepting the disclosure, not adding a new key). */}
            {auditProvider === 'anthropic' && !hasAnthropicKey && !hasConsentedSharedProvider.has('anthropic') && !hasUnconsentedSharedProvider.has('anthropic') && (
              <p className="text-xs text-amber-600 dark:text-amber-400 mt-1">
                Add an Anthropic key in Settings → LLM keys{' '}
                <Link to="/settings/llm" className="underline">Add key →</Link>
              </p>
            )}
            {auditProvider === 'openai' && !hasOpenAIKey && !hasConsentedSharedProvider.has('openai') && !hasUnconsentedSharedProvider.has('openai') && (
              <p className="text-xs text-amber-600 dark:text-amber-400 mt-1">
                Add an OpenAI key in Settings → LLM keys{' '}
                <Link to="/settings/llm" className="underline">Add key →</Link>
              </p>
            )}
            {auditProvider === 'ollama' && !hasOllamaConnection && (
              <p className="text-xs text-amber-600 dark:text-amber-400 mt-1">
                Configure a local Ollama connection in Settings → LLM keys{' '}
                <Link to="/settings/llm" className="underline">Configure →</Link>
              </p>
            )}


            <label className="block text-sm mt-4 mb-1" htmlFor="model">Model</label>
            {auditProvider !== '' && modelListing !== undefined && modelOptions.length === 0 ? (
              <p
                id="model"
                role="status"
                className="text-sm text-ink-secondary italic"
              >
                No models available for the selected provider.
              </p>
            ) : (
              <select
                id="model"
                value={auditModel}
                onChange={(e) => setAuditModel(e.target.value)}
                disabled={!auditEnabled || auditProvider === ''}
                className={`w-full rounded-md border border-line-strong bg-transparent px-3 py-2 text-sm ${!auditEnabled || auditProvider === '' ? 'opacity-50 cursor-not-allowed' : ''}`}
              >
                {auditProvider === '' && <option value="">Select a provider first</option>}
                {auditProvider !== '' && modelOptions.length === 0 && (
                  <option value="">Loading…</option>
                )}
                {modelOptions.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.id}{auditProvider !== 'ollama' && !m.hasPricing ? ' ⚠ no pricing' : ''}
                  </option>
                ))}
              </select>
            )}

            <div className="mt-6 flex items-center gap-3">
              <button
                type="button"
                onClick={handleSave}
                disabled={update.isPending || aiPatchEmpty}
                className="rounded-md border border-line-strong text-sm px-3 py-1.5 disabled:opacity-50 disabled:cursor-not-allowed hover:bg-white/5"
              >
                Save
              </button>
              {update.isPending && (
                <span className="text-xs text-ink-muted">Saving…</span>
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
