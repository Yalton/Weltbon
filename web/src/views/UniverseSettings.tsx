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

/**
 * Issue #48 Task 7: this used to narrow `'ollama'` out of every provider
 * comparison here (`toDisplayableAuditProvider`, since deleted) on the theory
 * that the AI Gap Auditor tab had no Ollama picker yet.
 *
 * Fix round 1 (Task 7 review): a first pass at this comment claimed the shim
 * risked *clobbering* a saved Ollama value on an unrelated Save. Traced —
 * that was wrong. `apFinal` was derived from live local state and never
 * passed through the shim at all, and the shim was applied to BOTH sides of
 * the `apFinal !== toDisplayableAuditProvider(data.auditProvider)` diff
 * check, so a stored `'ollama'` made both sides evaluate to `null`: the diff
 * read as "unchanged", `auditProvider` was omitted from the PATCH body, and
 * the stored value was never touched. The shim's only actual effect was
 * cosmetic: it hid a saved Ollama value from the picker's *display* by
 * hydrating local state to `''` instead of `'ollama'` on load — the field
 * looked unset even when the server had it saved.
 *
 * The real reason it had to go is a type one, not a data-safety one: once
 * `auditProvider` (local state) widened to include `'ollama'`, the shim's
 * return type `'anthropic' | 'openai' | null` could no longer even hold the
 * value passing through it — `auditProvider`, `Universe.auditProvider`
 * (useUniverse.ts), and the PATCH body's `auditProvider` field now all carry
 * the same `'anthropic' | 'openai' | 'ollama' | null` union straight
 * through, with no translation step to keep in sync or narrow the value on
 * the way in.
 */

/**
 * #50 Task 9 — the suffix a hosted-provider `<option>` carries, layered by
 * priority: a personal key needs no explanation (plain name); otherwise a
 * CONSENTED shared grant says so ("administrator-managed", matching the
 * vocabulary `SharedDisclosure.credentialOwner` already uses in
 * useLlmShares.ts/SharedLlmConnections.tsx); otherwise an UNCONSENTED grant
 * says what's blocking it; otherwise the pre-Task-9 "no key configured".
 * Never used for 'ollama' — that option's copy is untouched, still driven
 * only by `hasOllamaConnection` below.
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
  // #50 Task 9 — same defensive coercion as llmKeys above: `data` starts
  // undefined while loading, and the wrapper shape is `{ grants: [...] }`
  // rather than a bare array.
  const { data: sharedGrantsRaw } = useSharedLlmGrants();
  const sharedGrants = Array.isArray(sharedGrantsRaw?.grants) ? sharedGrantsRaw.grants : [];
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [confirmOpen, setConfirmOpen] = useState(false);

  // AI Gap Auditor local form state — hydrated from `data` on load.
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

  // Issue #48 Task 7: is THIS instance allowed to offer Ollama at all? A
  // hosted instance has no route to reach a user's local machine (see
  // OllamaConnectionSection's own file header) — offering the option there
  // would only ever fail against a 403 the server enforces independently.
  // `=== true` (not `!!`) so the brief "still loading /config" window reads
  // as "not local" rather than flashing the option in and out.
  const { localMode } = useInstanceConfig();
  const isLocal = localMode === true;
  // Desktop-only, so only fetched when it could possibly matter — mirrors
  // OllamaConnectionSection's own `enabled: isLocal` gate for the same
  // reason (no point asking a hosted server about a connection it will 403).
  const { data: ollamaConnection } = useLlmConnection('ollama', { enabled: isLocal });
  const hasOllamaConnection = ollamaConnection !== undefined;

  const hasAnthropicKey = llmKeys.some((k) => k.provider === 'anthropic');
  const hasOpenAIKey = llmKeys.some((k) => k.provider === 'openai');

  // #50 Task 9 — a hosted provider (anthropic/openai) is available through
  // EITHER a personal key OR a shared grant the recipient has consented to.
  // An unconsented grant is a DIFFERENT thing: it exists, but must not
  // enable the option (the recipient has not yet agreed to the disclosure)
  // and must not let this component probe /llm/models for it either — see
  // `canProbeModels` below. Computed as `Set`s (not booleans) so the
  // provider-option JSX and the model-probe gate below share one source of
  // truth instead of recomputing "is anthropic consented?" twice.
  const hasConsentedSharedProvider = new Set(
    sharedGrants.filter((grant) => grant.consentedAt !== null).map((grant) => grant.provider),
  );
  const hasUnconsentedSharedProvider = new Set(
    sharedGrants.filter((grant) => grant.consentedAt === null).map((grant) => grant.provider),
  );

  // Phase 27 D-01 — live model catalog for the active provider. Hook is
  // disabled (no fetch) when provider is empty; 30-min staleTime aligns with
  // backend cache TTL. Issue #48 Task 7: 'ollama' flows through the same
  // call now that useListModels' signature is widened — the backend
  // (llm-models.ts) has served it since Task 6; this call site was the only
  // thing that could not yet ask.
  //
  // #50 Task 9 — 'ollama' is always local/desktop and carries no shared
  // concept, so it probes unconditionally (unchanged from before this task).
  // For anthropic/openai, probing requires the SAME availability the
  // provider <option> below is enabled under: a personal key OR a consented
  // shared grant. An unconsented grant must not reach this branch — probing
  // the model route before consent is exactly the leak the brief's global
  // constraint rules out (the server 403s it, but the point is the UI must
  // never even try).
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

  // Phase 27 D-08 — default-selection fallback chain when the universe has no
  // saved auditModel yet:
  //   (1) RECOMMENDED_CHEAP_MODEL[provider] if present in the live list
  //   (2) live[0].id otherwise
  //   (3) '' (with "no models available" UI shown in place of the select)
  //
  // RECOMMENDED_CHEAP_MODEL has no 'ollama' entry (pricing.ts — there is no
  // single "cheapest" local model to recommend), so `recommended` is
  // `undefined` for that provider and step (1) always falls through to (2)
  // — exactly the "live[0] fallback" pricing.ts's own comment documents.
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
                const next = e.target.value as '' | 'anthropic' | 'openai' | 'ollama';
                setAuditProvider(next);
                // Reset model when provider changes — useEffect will populate default.
                setAuditModel('');
              }}
              disabled={!auditEnabled}
              className={`w-full rounded-md border border-neutral-300 dark:border-neutral-700 bg-transparent px-3 py-2 text-sm ${!auditEnabled ? 'opacity-50 cursor-not-allowed' : ''}`}
            >
              <option value="">Select provider</option>
              {/* #50 Task 9 — enabled by a personal key OR a CONSENTED shared
                  grant; an unconsented grant is visible but stays disabled,
                  with a link to settle consent (see the inline help below). */}
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
              {/* Issue #48 Task 7: only offered on a local (desktop) instance
                  — a hosted instance has no route to a user's machine, so
                  the option would only ever fail against the server's own
                  403 (llm-connections.ts). Not merely hidden-but-present:
                  omitted from the DOM entirely, matching
                  OllamaConnectionSection's "render nothing" contract for the
                  same instance fact. */}
              {isLocal && (
                <option value="ollama" disabled={!hasOllamaConnection}>
                  Ollama{!hasOllamaConnection ? ' (no connection configured)' : ''}
                </option>
              )}
            </select>

            {/* #50 Task 9 — an unconsented shared grant is informational
                regardless of which provider is CURRENTLY selected: an admin
                may have shared Anthropic while OpenAI is what's picked, and
                the recipient still needs to learn a connection is waiting on
                their consent. Not gated on `auditProvider === …`, unlike the
                "Add key" hints below — those stay per-selection since adding
                a key is an action for the selected provider specifically. */}
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

            {/* Model dropdown — Phase 27 D-05/D-08 live-driven, with the
                `⚠ no pricing` suffix on entries the user's BYOK key can call
                but PRICING does not yet cover. When the live list resolves
                to empty (provider has no models at all for this key), the
                <select> is replaced by an inline "no models available"
                message (D-08 chain step 3).

                Issue #48 Task 7: the suffix is suppressed for 'ollama'.
                model-catalog.ts's Ollama branch always returns
                `hasPricing: false` for every entry (Ollama never appears in
                PRICING — it is free/local, not "priced but uncovered"), so
                without this guard every single Ollama model would carry a
                warning suffix that means something different for this
                provider than for anthropic/openai: there it flags a real
                gap (BYOK key can call a model PRICING hasn't caught up to
                yet); here it would just be permanently, meaninglessly true. */}
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
