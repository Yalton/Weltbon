import { describe, it, expect } from 'vitest';
import { syncStatusCopy } from './syncStatusCopy';
import type { SyncLink } from '../hooks/useSyncLinks';

const NOW = new Date('2026-08-22T12:00:00Z');

const link = (over: Partial<SyncLink> = {}): SyncLink => ({
  id: 'L1', universeId: 'U1', remoteId: 'R1',
  remoteLabel: 'Weltbon', remoteBaseUrl: 'https://example.test',
  status: 'idle',
  lastSyncedAt: new Date(NOW.getTime() - 2 * 60_000).toISOString(),
  lastError: null, createdAt: NOW.toISOString(),
  autoSync: true, pausedReason: null, nextPollAt: null, failureCount: 0,
  ...over,
});

describe('syncStatusCopy', () => {
  it('reports a recent successful sync', () => {
    const { text, tone } = syncStatusCopy(link(), NOW);
    expect(text).toMatch(/2m ago/i);
    expect(tone).toBe('ok');
  });

  it('reports a run in flight', () => {
    expect(syncStatusCopy(link({ status: 'syncing' }), NOW).tone).toBe('busy');
  });

  it('names the wait while backed off, so an idle link is not mistaken for a broken one', () => {
    const { text, tone } = syncStatusCopy(
      link({ failureCount: 3, nextPollAt: new Date(NOW.getTime() + 4 * 60_000).toISOString() }),
      NOW,
    );
    expect(text).toMatch(/retrying in 4m/i);
    expect(tone).toBe('waiting');
  });

  it('states the remedy when paused on rejected credentials', () => {
    const { text, tone } = syncStatusCopy(link({ pausedReason: 'remote-unauthorized' }), NOW);
    expect(text).toMatch(/sign in|credential/i);
    expect(tone).toBe('paused');
  });

  it('states the remedy when paused on a lapsed subscription', () => {
    expect(syncStatusCopy(link({ pausedReason: 'remote-payment-required' }), NOW).text)
      .toMatch(/subscription|billing/i);
  });

  it('says auto-sync is off rather than implying a failure', () => {
    const { text, tone } = syncStatusCopy(link({ autoSync: false }), NOW);
    expect(text).toMatch(/auto-sync off/i);
    expect(tone).toBe('ok');
  });

  it('handles a link that has never synced', () => {
    expect(syncStatusCopy(link({ lastSyncedAt: null }), NOW).text).toMatch(/never/i);
  });
});
