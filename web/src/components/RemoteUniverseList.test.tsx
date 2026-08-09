/**
 * A-07's three states, and A-06's adopt-then-run sequence.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const adopt = vi.fn();
const link = vi.fn();
const run = vi.fn();
let rows: any[] = [];
let listState = { data: rows, isPending: false, error: null as unknown };

vi.mock('../hooks/useAdoptUniverse', () => ({
  useRemoteUniverses: () => listState,
  useAdoptUniverse: () => ({ mutateAsync: adopt, isPending: false }),
  useLinkRemoteUniverse: () => ({ mutateAsync: link, isPending: false }),
}));
vi.mock('../hooks/useSyncLinks', () => ({
  useRunSyncLink: () => ({ mutateAsync: run, isPending: false }),
}));

import { RemoteUniverseList } from './RemoteUniverseList';

const REMOTE = { id: 'r1', label: 'prod', baseUrl: 'https://prod.example', patSuffix: 'ab12', createdAt: 'x' };

beforeEach(() => {
  adopt.mockReset();
  link.mockReset();
  run.mockReset();
});

function setRows(next: any[]) {
  rows = next;
  listState = { data: rows, isPending: false, error: null };
}

describe('RemoteUniverseList (A-07)', () => {
  it('offers Adopt for a universe this instance does not have', async () => {
    setRows([{ id: 'u1', name: 'Aethel', description: '', updatedAt: 'x', localState: 'absent' }]);
    adopt.mockResolvedValue({ id: 'l1' });
    run.mockResolvedValue({ bootstrapped: false, conflicts: 0, appliedLocally: { upserted: { entries: 3 }, deleted: {} }, pushed: { upserted: {}, deleted: {} }, blobsPulled: 1, blobsPushed: 0, assetsRepairedLocally: 0, assetsRepairedOnPeer: 0, assetsSweptOnPeer: 0, assetsUnrepairable: 0, linkId: 'l1' });

    render(<RemoteUniverseList remote={REMOTE as any} />);
    await userEvent.click(screen.getByRole('button', { name: /adopt aethel/i }));

    // A-06: adopt, then the ORDINARY run — one user action, two requests.
    await waitFor(() => expect(adopt).toHaveBeenCalledWith({ remoteId: 'r1', universeId: 'u1' }));
    await waitFor(() => expect(run).toHaveBeenCalledWith({ id: 'l1' }));
  });

  it('offers Link, not Adopt, for a universe already here but unlinked', async () => {
    setRows([{ id: 'u1', name: 'Aethel', description: '', updatedAt: 'x', localState: 'present' }]);
    link.mockResolvedValue({ id: 'l1' });

    render(<RemoteUniverseList remote={REMOTE as any} />);
    expect(screen.queryByRole('button', { name: /adopt aethel/i })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: /link aethel/i }));
    expect(link).toHaveBeenCalledWith({ remoteId: 'r1', universeId: 'u1' });
  });

  it('shows a linked universe as linked, with nothing to press', () => {
    setRows([{ id: 'u1', name: 'Aethel', description: '', updatedAt: 'x', localState: 'linked' }]);
    render(<RemoteUniverseList remote={REMOTE as any} />);
    expect(screen.getByText(/linked/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /adopt aethel/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /link aethel/i })).toBeNull();
  });

  it('renders a failed adopt through the shared error copy, not raw text', async () => {
    setRows([{ id: 'u1', name: 'Aethel', description: '', updatedAt: 'x', localState: 'absent' }]);
    const { ApiError } = await import('../api/client');
    adopt.mockRejectedValue(new ApiError(409, { code: 'universe-already-local' }, 'nope'));

    render(<RemoteUniverseList remote={REMOTE as any} />);
    await userEvent.click(screen.getByRole('button', { name: /adopt aethel/i }));

    await waitFor(() => expect(screen.getByText(/already have that universe/i)).toBeInTheDocument());
    // A failed adopt must not then fire a run against a link that was never made.
    expect(run).not.toHaveBeenCalled();
  });

  it('says a first sync can be slow when images are involved (F-06)', () => {
    setRows([{ id: 'u1', name: 'Aethel', description: '', updatedAt: 'x', localState: 'absent' }]);
    render(<RemoteUniverseList remote={REMOTE as any} />);
    expect(screen.getByText(/several minutes/i)).toBeInTheDocument();
  });
});
