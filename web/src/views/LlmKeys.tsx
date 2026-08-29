/**
 * LlmKeys view — /settings/llm (Phase 22-05)
 *
 * Three states (post consent-gate):
 *   - consent gate (LLMKEY-07): non-dismissable block; entry UI hidden until accepted
 *   - loading skeleton
 *   - empty state
 *   - populated table with Re-validate / Replace / Revoke per row
 *
 * D-09 consent copy (locked at planning time, ships verbatim):
 *   "Before you add an LLM API key
 *
 *    Your worldbuilding content (entries, summaries, links, tags) will be sent
 *    to the LLM provider you choose to power the gap audit. The provider sees
 *    your text; you pay for the tokens; Weltbon stores your key encrypted at
 *    rest and never logs the plaintext.
 *
 *    [ I accept ]"
 *
 * D-08: I-accept button enabled immediately on render — no scroll-to-bottom gate.
 *
 * LLMKEY-03 frontend mirror: the LlmKey type intentionally excludes `key`;
 * the masked preview `••••••••<bodySuffix>` is the only thing rendered for a
 * configured key after submission. The view must never read a plaintext field
 * from a fetched row — only `bodySuffix` is rendered. The masking-invariant
 * grep gates in 22-05-PLAN acceptance criteria enforce this.
 *
 * #50 Task 8: SharedLlmConnections mounts above the consent gate in all three
 * branches. It is not gated by `llmConsentedAt` — that consent covers a key
 * the user pays for themselves, and a recipient of an administrator-provided
 * connection may never own one.
 *
 * Threat surface: T-22-05-01..06 mitigations enumerated in 22-05-PLAN.md.
 */

import { useState } from 'react';
import {
  useLlmKeys,
  useLlmConsent,
  useGrantLlmConsent,
  useRevokeLlmKey,
  useRevalidateLlmKey,
  type LlmKey,
} from '../hooks/useLlmKeys';
import { EmptyState } from '../components/EmptyState';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { CreateLlmKeyDialog } from '../components/CreateLlmKeyDialog';
import { PricingTable } from '../components/PricingTable';
import { OllamaConnectionSection } from '../components/OllamaConnectionSection';
import { SharedLlmConnections } from '../components/SharedLlmConnections';
import { formatRelative } from '../utils/formatRelative';
import { ApiError } from '../api/client';

const PROVIDER_LABELS: Record<string, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
};

export default function LlmKeys() {
  const consent = useLlmConsent();
  const grantConsent = useGrantLlmConsent();
  const { data, isPending, error: listError } = useLlmKeys();
  const revoke = useRevokeLlmKey();
  const revalidate = useRevalidateLlmKey();

  const [createOpen, setCreateOpen] = useState(false);
  const [replaceTarget, setReplaceTarget] = useState<LlmKey | null>(null);
  const [revokeTarget, setRevokeTarget] = useState<LlmKey | null>(null);

  // Per-row inline status for Re-validate.
  const [revalStatus, setRevalStatus] = useState<
    Record<string, { ok?: string; err?: string }>
  >({});

  // WR-08 fix: surface non-404 revoke failures (5xx / network) with an
  // inline error. 404 is silently invalidated (the row was already gone —
  // mirrors useRevokeToken pattern) but other failures previously left
  // the user with no signal at all (dialog closes, list refetches, row
  // reappears, no feedback).
  const [revokeError, setRevokeError] = useState<string | null>(null);

  const hasConsented = consent.data?.consentedAt != null;

  // ─── Loading consent ──────────────────────────────────────────────────────
  if (consent.isPending) {
    return (
      <div className="max-w-3xl">
        {/* Issue #48 Task 7: mounted ABOVE the BYOK consent gate deliberately
            — Ollama is a separate, local-only feature that sends no content
            to a third party, so it must not wait on the "I accept" consent
            this section's own copy has nothing to do with. Self-gates on
            local mode; renders nothing on a hosted instance or while still
            loading /api/config. */}
        <OllamaConnectionSection />
        {/* #50 Task 8: above the BYOK consent gate, like the Ollama section
            and for the same reason. A recipient running on an
            administrator's connection may never add a key of their own, and
            the gate's copy ("you pay for the tokens") describes an
            arrangement that is not theirs — gating their only route to the
            audit feature behind it would strand them on a form they have no
            reason to fill in. The panel self-hides when there are no
            grants, so this costs a user without one nothing. */}
        <SharedLlmConnections />
        <div className="mt-6 h-24 rounded-md bg-neutral-100 dark:bg-neutral-800 animate-pulse" />
      </div>
    );
  }

  // ─── Consent gate (LLMKEY-07) ─────────────────────────────────────────────
  if (!hasConsented) {
    return (
      <div className="max-w-3xl">
        <OllamaConnectionSection />
        <SharedLlmConnections />
        <section
          aria-labelledby="llm-consent-heading"
          data-testid="llm-consent-block"
          className="mt-2 rounded-md border border-neutral-200 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-900 p-5"
        >
          <h1
            id="llm-consent-heading"
            className="text-xl font-semibold tracking-tight"
          >
            Before you add an LLM API key
          </h1>
          <p className="mt-3 text-sm text-neutral-700 dark:text-neutral-300 leading-[1.55]">
            Your worldbuilding content (entries, summaries, links, tags) will be
            sent to the LLM provider you choose to power the gap audit. The
            provider sees your text; you pay for the tokens; Weltbon stores
            your key encrypted at rest and never logs the plaintext.
          </p>
          <div className="mt-5">
            <button
              type="button"
              onClick={() => grantConsent.mutate()}
              disabled={grantConsent.isPending}
              className="bg-[color:var(--color-accent)] text-white text-sm font-medium px-4 py-2 rounded-md hover:opacity-90 focus:outline-none focus:ring-2 focus:ring-[color:var(--color-accent)] focus:ring-offset-2 disabled:opacity-50"
            >
              {grantConsent.isPending ? 'Recording…' : 'I accept'}
            </button>
          </div>
          {grantConsent.error && (
            <p className="mt-2 text-sm text-red-500" role="alert">
              Could not record your consent. Try again in a moment.
            </p>
          )}
        </section>
      </div>
    );
  }

  // ─── Post-consent UI ──────────────────────────────────────────────────────

  const revokeBody = revokeTarget
    ? `Revoking the ${PROVIDER_LABELS[revokeTarget.provider] ?? revokeTarget.provider} key${revokeTarget.label ? ` "${revokeTarget.label}"` : ''} deletes it immediately. Audits using this key will stop working until you add a new one.`
    : '';

  const handleRevalidate = async (key: LlmKey) => {
    setRevalStatus((prev) => ({ ...prev, [key.id]: {} }));
    try {
      const res = await revalidate.mutateAsync({ id: key.id });
      setRevalStatus((prev) => ({
        ...prev,
        [key.id]: { ok: `Re-validated ${formatRelative(res.lastValidatedAt)}` },
      }));
    } catch (err) {
      const message =
        err instanceof ApiError
          ? err.message
          : 'Could not reach the server. Try again in a moment.';
      setRevalStatus((prev) => ({ ...prev, [key.id]: { err: message } }));
    }
  };

  return (
    <div className="max-w-3xl">
      <OllamaConnectionSection />
      <SharedLlmConnections />

      {/* Page header */}
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold tracking-tight">LLM API keys</h1>
        {data && data.length > 0 && (
          <button
            type="button"
            onClick={() => {
              setReplaceTarget(null);
              setCreateOpen(true);
            }}
            className="bg-[color:var(--color-accent)] text-white text-sm px-3 py-1.5 rounded-md focus:outline-none focus:ring-2 focus:ring-[color:var(--color-accent)] focus:ring-offset-2"
          >
            New key
          </button>
        )}
      </div>

      <p className="mt-2 text-sm text-neutral-600 dark:text-neutral-400 leading-[1.5]">
        Connect an Anthropic or OpenAI API key to enable the gap auditor on
        this account. Your worldbuilding content is sent to the chosen provider
        only; Weltbon stores your key encrypted at rest.
      </p>

      {/* Loading state */}
      {isPending && (
        <div
          className="mt-6 space-y-2"
          aria-busy="true"
          aria-label="Loading LLM keys"
        >
          {[0, 1, 2].map((i) => (
            <div
              key={i}
              className="h-12 rounded-md bg-neutral-100 dark:bg-neutral-800 animate-pulse"
            />
          ))}
        </div>
      )}

      {/* WR-02 fix: explicit error state — without this branch, a failed
          GET /api/llm-keys would leave isPending=false + data=undefined,
          so every branch below is also false and the user sees only the
          page header with no error or retry affordance. */}
      {!isPending && listError && (
        <div
          role="alert"
          data-testid="llm-keys-list-error"
          className="mt-6 rounded-md border border-red-300 bg-red-50 dark:border-red-800 dark:bg-red-950/30 p-4 text-sm text-red-700 dark:text-red-300"
        >
          Could not load your LLM keys. Refresh the page to try again.
        </div>
      )}

      {/* Empty state */}
      {!isPending && !listError && data && data.length === 0 && (
        <div className="mt-6">
          <EmptyState
            title="No LLM API keys yet"
            body="Add an Anthropic or OpenAI key to enable the gap auditor."
            action={
              <button
                type="button"
                onClick={() => {
                  setReplaceTarget(null);
                  setCreateOpen(true);
                }}
                className="bg-[color:var(--color-accent)] text-white text-sm font-medium px-4 py-2 rounded-md hover:opacity-90 focus:outline-none focus:ring-2 focus:ring-[color:var(--color-accent)] focus:ring-offset-2"
              >
                Add your first key
              </button>
            }
          />
        </div>
      )}

      {/* WR-08 fix: inline revoke-failure notice (non-404). 404 is silent. */}
      {revokeError && (
        <div
          role="alert"
          data-testid="llm-keys-revoke-error"
          className="mt-6 rounded-md border border-red-300 bg-red-50 dark:border-red-800 dark:bg-red-950/30 p-3 text-sm text-red-700 dark:text-red-300 flex items-center justify-between"
        >
          <span>{revokeError}</span>
          <button
            type="button"
            onClick={() => setRevokeError(null)}
            className="ml-3 text-xs underline opacity-80 hover:opacity-100"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* Phase 26 D-14: Models & pricing transparency. Collapsible <details>
          mount placed ABOVE the keys table so users discover the pricing
          surface as the first thing post-consent; default-collapsed keeps the
          page tight for users who already know the rates. */}
      <PricingTable />

      {/* Populated state */}
      {!isPending && !listError && data && data.length > 0 && (
        <div className="mt-6 overflow-x-auto">
          <table data-testid="llm-keys-table" className="w-full text-sm">
            <caption className="sr-only">Your configured LLM API keys</caption>
            <thead>
              <tr className="border-b border-neutral-200 dark:border-neutral-800">
                <th scope="col" className="pb-2 text-left text-xs uppercase tracking-wide font-medium text-neutral-500 w-32">
                  Provider
                </th>
                <th scope="col" className="pb-2 text-left text-xs uppercase tracking-wide font-medium text-neutral-500 w-48">
                  Preview
                </th>
                <th scope="col" className="pb-2 text-left text-xs uppercase tracking-wide font-medium text-neutral-500 w-auto">
                  Label
                </th>
                <th scope="col" className="pb-2 text-left text-xs uppercase tracking-wide font-medium text-neutral-500 w-32">
                  Created
                </th>
                <th scope="col" className="pb-2 text-left text-xs uppercase tracking-wide font-medium text-neutral-500 w-40">
                  Last validated
                </th>
                {/* Phase 26 D-14: per-key cumulative spend (approximate;
                    joined by provider+user_id since audit_runs lacks
                    byok_key_id — see CONTEXT.md D-14 known limitation). */}
                <th scope="col" className="pb-2 text-left text-xs uppercase tracking-wide font-medium text-neutral-500 w-32">
                  Total spent
                </th>
                <th scope="col" className="pb-2 text-right text-xs uppercase tracking-wide font-medium text-neutral-500 w-56">
                  {/* action column */}
                </th>
              </tr>
            </thead>
            <tbody>
              {data.map((llmKey) => {
                const status = revalStatus[llmKey.id];
                return (
                  <tr
                    key={llmKey.id}
                    className="border-b border-neutral-100 dark:border-neutral-800 last:border-0"
                  >
                    <th scope="row" className="py-3 pr-4 text-left font-normal text-sm leading-[1.5]">
                      {PROVIDER_LABELS[llmKey.provider] ?? llmKey.provider}
                    </th>
                    <td
                      className="py-3 pr-4 font-mono text-sm leading-[1.5]"
                      data-testid={`llmkey-preview-${llmKey.id}`}
                    >
                      {`••••••••${llmKey.bodySuffix}`}
                    </td>
                    <td className="py-3 pr-4 text-sm leading-[1.5]">
                      {llmKey.label ? (
                        llmKey.label
                      ) : (
                        <span className="italic text-neutral-500">(unnamed)</span>
                      )}
                    </td>
                    <td className="py-3 pr-4 text-sm leading-[1.5]">
                      <time
                        dateTime={llmKey.createdAt}
                        title={new Date(llmKey.createdAt).toLocaleString()}
                      >
                        {formatRelative(llmKey.createdAt)}
                      </time>
                    </td>
                    <td className="py-3 pr-4 text-sm leading-[1.5]">
                      {llmKey.lastValidatedAt ? (
                        <time
                          dateTime={llmKey.lastValidatedAt}
                          title={new Date(llmKey.lastValidatedAt).toLocaleString()}
                        >
                          {formatRelative(llmKey.lastValidatedAt)}
                        </time>
                      ) : (
                        <span className="text-neutral-500">Never</span>
                      )}
                      {status?.ok && (
                        <span
                          className="ml-2 text-xs text-emerald-600 dark:text-emerald-400"
                          data-testid={`reval-ok-${llmKey.id}`}
                        >
                          {status.ok}
                        </span>
                      )}
                      {status?.err && (
                        <span
                          className="ml-2 text-xs text-red-500"
                          role="alert"
                          data-testid={`reval-err-${llmKey.id}`}
                        >
                          {status.err}
                        </span>
                      )}
                    </td>
                    {/* Phase 26 D-14: per-key Total spent. Server already
                        4-decimal-formats `totalSpentUsd` (Plan 08); we prefix
                        $ literal here. Defensive fallback to "0.0000" handles
                        any pre-Plan-08 cached row that lacks the field.

                        Phase 27 D-06: when the key's provider has audit runs
                        flagged `cost_unknown=true`, append a neutral footnote
                        "(plus N runs with unknown pricing)". Tone is neutral
                        (NOT amber) per CONTEXT line 174 — this is
                        informational metadata at the aggregate level; the
                        amber chip is reserved for per-run cost surfaces. */}
                    <td
                      className="py-3 pr-4 text-sm leading-[1.5] tabular-nums text-neutral-700 dark:text-neutral-300"
                      data-testid={`llmkey-total-spent-${llmKey.id}`}
                    >
                      ${llmKey.totalSpentUsd ?? '0.0000'}
                      {(llmKey.costUnknownCount ?? 0) > 0 && (
                        <span className="text-xs text-neutral-500 ml-1">
                          (plus {llmKey.costUnknownCount} runs with unknown pricing)
                        </span>
                      )}
                    </td>
                    <td className="py-3 text-right">
                      <div className="flex justify-end gap-3">
                        <button
                          type="button"
                          onClick={() => handleRevalidate(llmKey)}
                          className="text-sm text-neutral-600 dark:text-neutral-400 hover:text-[color:var(--color-accent)]"
                        >
                          Re-validate
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setReplaceTarget(llmKey);
                            setCreateOpen(true);
                          }}
                          className="text-sm text-neutral-600 dark:text-neutral-400 hover:text-[color:var(--color-accent)]"
                        >
                          Replace
                        </button>
                        <button
                          type="button"
                          onClick={() => setRevokeTarget(llmKey)}
                          className="text-sm text-neutral-600 dark:text-neutral-400 hover:text-red-600 dark:hover:text-red-500"
                        >
                          Revoke
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Create / Replace dialog */}
      <CreateLlmKeyDialog
        open={createOpen}
        onOpenChange={(o) => {
          setCreateOpen(o);
          if (!o) setReplaceTarget(null);
        }}
        replaceTarget={
          replaceTarget
            ? {
                id: replaceTarget.id,
                provider: replaceTarget.provider,
                label: replaceTarget.label,
              }
            : null
        }
        onCreated={() => {
          // Optional callback — TanStack Query already invalidates the list.
        }}
      />

      {/* Revoke confirmation */}
      <ConfirmDialog
        open={!!revokeTarget}
        onOpenChange={(o) => {
          if (!o) setRevokeTarget(null);
        }}
        title="Revoke key"
        body={revokeBody}
        confirmLabel="Revoke key"
        cancelLabel="Cancel"
        destructive={true}
        onConfirm={async () => {
          if (revokeTarget) {
            setRevokeError(null);
            try {
              await revoke.mutateAsync({ id: revokeTarget.id });
            } catch (err) {
              // WR-08 fix: 404 races are fine (the row was already gone —
              // useRevokeLlmKey's onError invalidates the cache so the row
              // disappears). Non-404 failures (5xx, network) need a visible
              // signal — surface a generic message and stop the silent swallow.
              if (err instanceof ApiError && err.status === 404) {
                // Silent — the cache invalidate will remove the stale row.
              } else {
                setRevokeError("Couldn't revoke the key. It may still be active — refresh to confirm.");
              }
            }
            // WR-06 fix: explicitly clear the target so the dialog closes
            // even when ConfirmDialog doesn't auto-close on confirm. Without
            // this, a successful revoke could leave the dialog open after
            // the row vanished from the table, looking like the dialog
            // forgot the just-deleted target.
            setRevokeTarget(null);
          }
        }}
      />
    </div>
  );
}
