/**
 * #50 Task 8 — the recipient's view of an administrator-provided LLM
 * connection, mounted on the LLM keys settings page.
 *
 * ── Why this renders ABOVE the personal BYOK consent gate ────────────────
 * LlmKeys.tsx blocks its own UI behind "Before you add an LLM API key" until
 * the user accepts it. That consent is about a key the user pays for
 * themselves, and its copy says exactly that ("you pay for the tokens"). A
 * recipient of a shared connection may never add a key at all — gating their
 * only path to the audit feature behind a disclosure about a different
 * arrangement would leave them staring at a form they have no reason to fill
 * in. Same reasoning the Ollama section already uses, and the same placement.
 *
 * ── Why consent is per-grant and revocable, when the global one is not ───
 * The personal consent (D-07) is recorded once and never cleared: the user is
 * consenting to their own content leaving for their own key. Here the
 * credential belongs to someone else and the arrangement can be withdrawn by
 * either side, so the recipient needs a way to step out of it that does not
 * involve asking an administrator. Withdrawal takes effect at the next audit
 * checkpoint, which is why the copy says so rather than implying a running
 * audit stops instantly.
 *
 * ── What this component must never render ────────────────────────────────
 * Owner identity in any form, and key material in any form — including the
 * masked `••••••••<suffix>` preview LlmKeys legitimately shows for the user's
 * OWN key. The recipient's types (hooks/useLlmShares.ts) carry neither, so
 * this is enforced by what is available rather than by discipline here; the
 * test asserts it anyway, because the shape of the type is exactly the kind
 * of thing a later "just add the owner name" change would quietly widen.
 */

import { useState } from 'react';
import {
  useSharedLlmGrants,
  useConsentSharedLlmGrant,
  useWithdrawSharedLlmConsent,
  type SharedGrant,
} from '../hooks/useLlmShares';
import { ConfirmDialog } from './ConfirmDialog';
import { ApiError } from '../api/client';

function statusMessage(err: unknown): string {
  return err instanceof ApiError
    ? err.message
    : 'Could not reach the server. Try again in a moment.';
}

function GrantCard({ grant }: { grant: SharedGrant }) {
  const consent = useConsentSharedLlmGrant();
  const withdraw = useWithdrawSharedLlmConsent();
  const [confirmWithdraw, setConfirmWithdraw] = useState(false);
  const [outcome, setOutcome] = useState('');

  const providerName = grant.disclosure.providerName;
  const accepted = grant.consentedAt !== null;
  const pending = consent.isPending || withdraw.isPending;
  // Review finding: `consent.error ?? withdraw.error` kept showing a failed
  // withdrawal's alert next to a connection a later Accept had just fixed.
  // Only the action the user last invoked can be the one they are reading
  // about, so the error is keyed to it.
  const [lastAction, setLastAction] = useState<'consent' | 'withdraw' | null>(null);
  const error = lastAction === 'consent' ? consent.error : lastAction === 'withdraw' ? withdraw.error : null;

  return (
    <li
      data-testid={`shared-llm-grant-${grant.id}`}
      className="rounded-md border border-neutral-200 dark:border-neutral-800 p-4"
    >
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="text-sm font-medium">{providerName} (shared)</h3>
        <span className="text-xs text-neutral-500 dark:text-neutral-400">
          {accepted ? 'Accepted' : 'Not yet accepted'}
        </span>
      </div>

      <p className="mt-2 text-sm text-neutral-700 dark:text-neutral-300 leading-[1.55]">
        Your content leaves this instance: entries, summaries, links and tags
        are sent to {providerName} to run the audit. The credential is
        administrator-managed — an administrator pays for the tokens, and can
        withdraw this connection at any time.
      </p>

      <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-neutral-600 dark:text-neutral-400">
        <dt>Monthly allowance</dt>
        <dd>
          ${grant.usage.settledUsd} used of ${grant.usage.limitUsd} monthly limit
        </dd>
        <dt>Reserved right now</dt>
        <dd>${grant.usage.reservedUsd}</dd>
        <dt>Audits this month</dt>
        <dd>
          {grant.usage.completedAudits} completed, {grant.usage.failedAudits} failed
        </dd>
        <dt>Running now</dt>
        <dd>
          {grant.usage.activeAudits} of {grant.usage.maxConcurrentAudits} at a time
        </dd>
        <dt>Disclosure version</dt>
        <dd>{grant.policyVersion}</dd>
      </dl>

      <div className="mt-4 flex items-center gap-3">
        {accepted ? (
          <button
            type="button"
            onClick={() => setConfirmWithdraw(true)}
            disabled={pending}
            className="text-sm px-3 py-1.5 rounded-md border border-neutral-300 dark:border-neutral-700 hover:bg-neutral-50 dark:hover:bg-neutral-800 focus:outline-none focus:ring-2 focus:ring-[color:var(--color-accent)] focus:ring-offset-2 disabled:opacity-50"
          >
            {`Withdraw consent for ${providerName} shared connection`}
          </button>
        ) : (
          <button
            type="button"
            onClick={() => {
              setLastAction('consent');
              setOutcome('');
              consent.mutate(
                { grantId: grant.id },
                { onSuccess: () => setOutcome(`${providerName} shared connection accepted.`) },
              );
            }}
            disabled={pending}
            className="bg-[color:var(--color-accent)] text-white text-sm font-medium px-4 py-2 rounded-md hover:opacity-90 focus:outline-none focus:ring-2 focus:ring-[color:var(--color-accent)] focus:ring-offset-2 disabled:opacity-50"
          >
            {`Accept ${providerName} shared connection`}
          </button>
        )}
      </div>

      {/* One live region per card, carrying both outcomes: a screen reader
          user acting on a specific connection needs the result of THAT
          action, not a page-level status that could belong to any card.
          Review finding: it used to announce only 'Saving…', so a completed
          accept-or-withdraw — the entire point of the interaction — passed
          silently, with the button label as the only evidence. */}
      <p
        aria-live="polite"
        className="mt-2 text-xs text-neutral-500 dark:text-neutral-400 empty:mt-0"
      >
        {pending ? 'Saving…' : outcome}
      </p>
      {error && (
        <p className="mt-1 text-sm text-red-500" role="alert">
          {statusMessage(error)}
        </p>
      )}

      {/* Review finding: this was a single unguarded click, while key
          revocation two components over goes through ConfirmDialog. It is
          less severe than deleting a key — re-accepting is one click and the
          server is idempotent — but it is not free either: the engine's
          checkpoint kills a running audit, so the recipient loses that run's
          output while the owner has already paid for the turns it spent.
          That consequence belongs at the moment of decision, which is why
          the sentence moved off the card and into the dialog body. */}
      <ConfirmDialog
        open={confirmWithdraw}
        onOpenChange={setConfirmWithdraw}
        title={`Withdraw ${providerName} consent`}
        body={
          `You will stop being able to run audits on the ${providerName} connection ` +
          'an administrator shared with you, until you accept it again. This takes ' +
          'effect at the next audit checkpoint: an audit already running will stop ' +
          'rather than finish, and its results are discarded.'
        }
        confirmLabel="Withdraw consent"
        cancelLabel="Keep it"
        destructive={true}
        onConfirm={() => {
          setLastAction('withdraw');
          setOutcome('');
          withdraw.mutate(
            { grantId: grant.id },
            { onSuccess: () => setOutcome(`${providerName} shared connection withdrawn.`) },
          );
          setConfirmWithdraw(false);
        }}
      />
    </li>
  );
}

export function SharedLlmConnections() {
  const { data, isPending, error } = useSharedLlmGrants();

  // A user with no shared connection is the common case, and an empty
  // "Shared connections" heading would be noise on every settings visit for
  // every self-hoster who will never have one. Nothing renders until there
  // is something to say — including while loading, so the page does not
  // reflow a skeleton in and out for the majority who have no grants.
  if (isPending) return null;

  if (error) {
    return (
      <section
        aria-labelledby="shared-llm-heading"
        data-testid="shared-llm-connections"
        className="mb-6"
      >
        <h2 id="shared-llm-heading" className="text-lg font-semibold tracking-tight">
          Shared LLM connections
        </h2>
        <p className="mt-2 text-sm text-red-500" role="alert">
          Could not load your shared connections. Reload the page to try again.
        </p>
      </section>
    );
  }

  const grants = data?.grants ?? [];
  if (grants.length === 0) return null;

  return (
    <section
      aria-labelledby="shared-llm-heading"
      data-testid="shared-llm-connections"
      className="mb-6"
    >
      <h2 id="shared-llm-heading" className="text-lg font-semibold tracking-tight">
        Shared LLM connections
      </h2>
      <p className="mt-1 text-sm text-neutral-600 dark:text-neutral-400">
        An administrator has made a provider connection available to you. You
        can run audits on it without adding a key of your own.
      </p>
      <ul className="mt-3 space-y-3">
        {grants.map((grant) => (
          <GrantCard key={grant.id} grant={grant} />
        ))}
      </ul>
    </section>
  );
}
