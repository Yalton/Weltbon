import type { SyncLink } from '../hooks/useSyncLinks';
import { formatRelative } from '../utils/formatRelative';

export type SyncStatusTone = 'ok' | 'busy' | 'waiting' | 'paused';

export type SyncStatusKind = 'paused' | 'auto-off' | 'syncing' | 'retrying' | 'never' | 'synced';

export interface SyncStatusResult {
  text: string;
  tone: SyncStatusTone;
  kind: SyncStatusKind;
}

const PAUSED_REMEDY: Record<string, string> = {
  'remote-unauthorized':
    'Paused: sign in to the remote instance again and save a fresh access token.',
  'remote-payment-required':
    'Paused: the remote instance needs an active subscription. Resolve billing there to resume.',
  'remote-quota-exceeded':
    'Paused: the remote instance is out of storage. Free up space there to resume.',
  'remote-incompatible':
    'Paused: the two instances are running incompatible versions. Update the older one to resume.',
  // error. Auto-sync can now reach this state on its own (#62), where before
  'remote-universe-missing':
    'Paused: this universe no longer exists on the remote. Re-link it there, or remove this link.',
};

function pausedText(reason: string): string {
  return PAUSED_REMEDY[reason] ?? `Paused: ${reason}. See Sync now to try clearing it manually.`;
}

function abbreviateAgo(relative: string): string {
  return relative
    .replace(/^(\d+) minutes? ago$/, '$1m ago')
    .replace(/^(\d+) hours? ago$/, '$1h ago')
    .replace(/^(\d+) days? ago$/, '$1d ago')
    .replace(/^(\d+) weeks? ago$/, '$1w ago')
    .replace(/^(\d+) months? ago$/, '$1mo ago')
    .replace(/^(\d+) years? ago$/, '$1y ago');
}

export function syncStatusCopy(link: SyncLink, now: Date): SyncStatusResult {
  if (link.pausedReason) {
    return { text: pausedText(link.pausedReason), tone: 'paused', kind: 'paused' };
  }

  if (!link.autoSync) {
    return { text: 'Auto-sync off. Use Sync now to sync manually.', tone: 'ok', kind: 'auto-off' };
  }

  if (link.status === 'syncing') {
    return { text: 'Syncing…', tone: 'busy', kind: 'syncing' };
  }

  // Backoff (AS-08): `failureCount > 0` while the link is neither paused nor
  // mid-run means the last attempt failed transiently and a retry is
  // 1-minute floor keeps the line honest ("retrying soon") instead of
  if (link.failureCount > 0) {
    const targetMs = link.nextPollAt !== null ? new Date(link.nextPollAt).getTime() : now.getTime();
    const minutes = Math.max(1, Math.ceil((targetMs - now.getTime()) / 60_000));
    return { text: `Retrying in ${minutes}m`, tone: 'waiting', kind: 'retrying' };
  }

  if (link.lastSyncedAt === null) {
    return { text: 'Never synced', tone: 'ok', kind: 'never' };
  }

  // `formatRelative` capitalises "Just now" for its own (sentence-start)
  // callers; composed mid-sentence here ("Synced Just now") that reads as a
  // typo. Lower-casing only the leading character of the COMPOSED string —
  // which are otherwise reused as-is — fixes this for every shape they can
  // emit ("Just now" -> "just now"; every other shape already starts with a
  const relative = abbreviateAgo(formatRelative(link.lastSyncedAt, now));
  const lowered = relative.charAt(0).toLowerCase() + relative.slice(1);
  return { text: `Synced ${lowered}`, tone: 'ok', kind: 'synced' };
}
