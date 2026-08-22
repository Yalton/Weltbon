/**
 * Task 7 (#44, AS-09/AS-10) — one status line for a sync link row.
 *
 * PRECEDENCE, and it matters: paused, then auto-sync-off, then syncing, then
 * backed-off, then last-synced. A link can be simultaneously "off" and
 * "behind on its last real error" — off wins, because the user's own choice
 * to pause automation must never be relabelled as a fault. Likewise a link
 * that is both mid-backoff and has a last-synced timestamp shows the backoff,
 * because that is the more urgent fact right now.
 *
 * TONE. `'ok'` is used for BOTH a healthy sync and a deliberate auto-sync-off
 * — never `'paused'` for the latter. Colouring a choice the same as a fault
 * trains people to stop trusting the fault colour.
 *
 * PAUSED REMEDIES. `pausedReason` carries a `SyncRunError` code
 * (api/src/services/sync/run-errors.ts). Each entry here states the REMEDY,
 * not the symptom — `SYNC_ERROR_COPY` in syncErrorCopy.ts already exists for
 * the symptom sentence shown elsewhere (the run-error notice); this module is
 * deliberately not reused for it because the paused line has to fit a single
 * status row rather than a notice block, and needs an imperative, not a
 * description.
 */
import type { SyncLink } from '../hooks/useSyncLinks';
import { formatRelative } from '../utils/formatRelative';

export type SyncStatusTone = 'ok' | 'busy' | 'waiting' | 'paused';

export interface SyncStatusResult {
  text: string;
  tone: SyncStatusTone;
}

/** Remedy copy for the `SyncRunError` codes that can actually pause a link. */
const PAUSED_REMEDY: Record<string, string> = {
  'remote-unauthorized':
    'Paused: sign in to the remote instance again and save a fresh access token.',
  'remote-payment-required':
    'Paused: the remote instance needs an active subscription. Resolve billing there to resume.',
  'remote-quota-exceeded':
    'Paused: the remote instance is out of storage. Free up space there to resume.',
  'remote-incompatible':
    'Paused: the two instances are running incompatible versions. Update the older one to resume.',
};

/**
 * Every other pause code (`remote-universe-missing`, `forbidden`,
 * `remote-universe-forbidden`, `blob-unavailable`, `link-not-found`,
 * `remote-key-undecryptable`, `apply-rejected`, or any future code this map
 * has not caught up to) falls back to a generic line that still NAMES the
 * code, so the user has something to search on or report, rather than a dead
 * end.
 */
function pausedText(reason: string): string {
  return PAUSED_REMEDY[reason] ?? `Paused: ${reason}. See Sync now to try clearing it manually.`;
}

/**
 * `formatRelative` buckets into "N minute(s)/hour(s)/… ago"; this row needs
 * the compact form. Reused rather than reimplemented — this only reformats
 * the string formatRelative already computed, it does not recompute the
 * bucket or the delta itself.
 */
function abbreviateAgo(relative: string): string {
  return relative
    .replace(/^(\d+) minutes? ago$/, '$1m ago')
    .replace(/^(\d+) hours? ago$/, '$1h ago')
    .replace(/^(\d+) days? ago$/, '$1d ago')
    .replace(/^(\d+) weeks? ago$/, '$1w ago')
    .replace(/^(\d+) months? ago$/, '$1mo ago')
    .replace(/^(\d+) years? ago$/, '$1y ago');
}

/** One status line for a sync link row. See the precedence order above. */
export function syncStatusCopy(link: SyncLink, now: Date): SyncStatusResult {
  if (link.pausedReason) {
    return { text: pausedText(link.pausedReason), tone: 'paused' };
  }

  if (!link.autoSync) {
    return { text: 'Auto-sync off. Use Sync now to sync manually.', tone: 'ok' };
  }

  if (link.status === 'syncing') {
    return { text: 'Syncing…', tone: 'busy' };
  }

  // Backoff (AS-08): `failureCount > 0` while the link is neither paused nor
  // mid-run means the last attempt failed transiently and a retry is
  // scheduled. `nextPollAt` may already be in the past by the time this
  // renders (the scheduler's own tick has not caught up yet); clamping to a
  // 1-minute floor keeps the line honest ("retrying soon") instead of
  // printing a negative or zero count.
  if (link.failureCount > 0) {
    const targetMs = link.nextPollAt !== null ? new Date(link.nextPollAt).getTime() : now.getTime();
    const minutes = Math.max(1, Math.ceil((targetMs - now.getTime()) / 60_000));
    return { text: `Retrying in ${minutes}m`, tone: 'waiting' };
  }

  if (link.lastSyncedAt === null) {
    return { text: 'Never synced', tone: 'ok' };
  }

  return { text: `Synced ${abbreviateAgo(formatRelative(link.lastSyncedAt, now))}`, tone: 'ok' };
}
