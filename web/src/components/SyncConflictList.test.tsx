/**
 * SyncConflictList tests — Plan F (Task 4), the LWW-loser review surface.
 *
 * Pins the two decisions this component implements:
 *   - F-03: show the LOSING version plus a deep link, never a diff. The ledger
 *     stores only `loserPayload`; there is no winner payload to diff against,
 *     so a "diff" here could only be fabricated.
 *   - F-04: one flat list, newest first, exactly as the server returned it.
 *     The order test asserts POSITION, not presence — a presence assertion
 *     passes against a component that sorts by anything at all.
 *
 * Error prose is asserted against SYNC_ERROR_COPY, never retyped. A retyped
 * string would pass against a component that hardcoded its own copy, and break
 * on every deliberate copy edit.
 *
 * NEGATIVE ASSERTIONS USE APOSTROPHE-FREE PHRASES. The sync UI renders
 * typographic apostrophes (U+2019), so `queryByText(/doesn't/)` with a straight
 * quote can never match and would pass no matter what the component did.
 *
 * `tableName` and `rowId` are opaque TEXT, not uuids: the merge engine keys the
 * universe singleton on the literal string 'universe' (D-14), and `tableName`
 * is a manifest COLLECTION name. The fixtures below include that singleton so
 * no uuid assumption can creep in unnoticed.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';

// Keep the REAL ApiError: `syncErrorMessage` narrows with `instanceof ApiError`
// against this same module, so a locally redeclared class would make every
// error fall through to the generic branch and quietly defeat the tests below.
vi.mock('../api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/client')>();
  return { ...actual, api: vi.fn() };
});

import { api, ApiError } from '../api/client';
import { SYNC_ERROR_COPY } from '../lib/syncErrorCopy';
import { SyncConflictList } from './SyncConflictList';
import { makeApiDispatcher, type ApiHandler } from '../test/apiDispatcher';

function makeClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
}

function renderList(universeId = 'u1') {
  // MemoryRouter because F-03's deep link is a react-router <Link>.
  return render(
    <QueryClientProvider client={makeClient()}>
      <MemoryRouter>
        <SyncConflictList universeId={universeId} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function dispatch(routes: Record<string, ApiHandler>) {
  return makeApiDispatcher(routes);
}

const LIST_PATH = '/sync/conflicts?universeId=u1';

/**
 * THE FIXTURE IS ARRANGED SO A CLIENT-SIDE SORT VISIBLY REORDERS IT, and that
 * arrangement is load-bearing for the F-04 order test below. The first draft had
 * the NEWER row as `entries` and the older one as `universe` — 'entries' sorts
 * before 'universe', so the newest-first order and the alphabetical order were
 * IDENTICAL, and a `sort((a,b) => a.tableName.localeCompare(b.tableName))` bolted
 * into the component changed nothing and killed no test. Verified by actually
 * making that mutation.
 *
 * With `universe` newest and `entries` older, the three plausible sorts each
 * reverse the pair: by `tableName` ascending, by `createdAt` ascending, and by
 * `rowId`. Only "leave it alone" keeps c1 first.
 */

/**
 * Newest. The universe singleton — `rowId` is the literal string 'universe',
 * not a uuid (D-14), and there is no per-row page for it, so this row is the
 * not-deep-linkable half of the F-03 link test.
 */
const NEWER = {
  id: 'c1',
  universeId: 'u1',
  tableName: 'universe',
  rowId: 'universe',
  winner: 'local',
  loserPayload: { id: 'u1', name: 'Remote name that lost' },
  resolvedAt: null as string | null,
  createdAt: '2026-08-04T12:00:00.000Z',
};

/** Older. An entry row, so it IS deep-linkable, and it sorts first by every
 *  field a "helpful" sort might reach for. */
const OLDER = {
  id: 'c2',
  universeId: 'u1',
  tableName: 'entries',
  rowId: 'e-77',
  winner: 'remote',
  loserPayload: { id: 'e-77', title: 'Aldric the Unbroken', summary: 'the local text that lost' },
  resolvedAt: null as string | null,
  createdAt: '2026-08-02T09:00:00.000Z',
};

beforeEach(() => {
  vi.mocked(api).mockReset();
});

describe('SyncConflictList', () => {
  it('renders one flat list in the order the server returned (F-04)', async () => {
    // The server sorts newest first. The component must not re-derive that:
    // any client-side sort silently replaces the contract this surface exists
    // to render, and ties on `createdAt` would reorder differently again.
    vi.mocked(api).mockImplementation(dispatch({ [LIST_PATH]: [NEWER, OLDER] }));

    renderList();

    await screen.findByTestId('sync-conflict-row-c1');

    // POSITION, not presence — presence passes against any ordering at all.
    const rows = screen.getAllByRole('listitem');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveAttribute('data-testid', 'sync-conflict-row-c1');
    expect(rows[1]).toHaveAttribute('data-testid', 'sync-conflict-row-c2');

    // F-04 is also "flat": no grouping headings between content and positional
    // collections. One list, and only one.
    expect(screen.getAllByRole('list')).toHaveLength(1);
  });

  it('names which side won, per row', async () => {
    vi.mocked(api).mockImplementation(dispatch({ [LIST_PATH]: [NEWER, OLDER] }));

    renderList();

    const localWon = await screen.findByTestId('sync-conflict-row-c1');
    const remoteWon = screen.getByTestId('sync-conflict-row-c2');

    // Scoped `within`, so "the remote won" being rendered on the WRONG row
    // cannot satisfy this.
    expect(within(remoteWon).getByText(/the remote instance won/i)).toBeInTheDocument();
    expect(within(localWon).getByText(/this instance won/i)).toBeInTheDocument();
  });

  it('shows the losing payload, and never claims to show a diff (F-03)', async () => {
    vi.mocked(api).mockImplementation(dispatch({ [LIST_PATH]: [OLDER] }));

    renderList();

    const row = await screen.findByTestId('sync-conflict-row-c2');
    // The payload really is on screen — the positive precondition for the
    // negative assertion below.
    expect(within(row).getByTestId('sync-conflict-payload-c2')).toHaveTextContent(
      'Aldric the Unbroken',
    );
    expect(within(row).getByTestId('sync-conflict-payload-c2')).toHaveTextContent(
      'the local text that lost',
    );
    // Apostrophe-free by construction, so this can actually match if it is ever
    // rendered. The ledger holds no winner payload, so a diff is unofferable.
    expect(screen.queryByText(/compare/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/\bdiff\b/i)).not.toBeInTheDocument();
  });

  it('deep-links an addressable row, and links nothing it cannot address (F-03)', async () => {
    vi.mocked(api).mockImplementation(dispatch({ [LIST_PATH]: [NEWER, OLDER] }));

    renderList();

    const entryRow = await screen.findByTestId('sync-conflict-row-c2');
    // `rowId` is the entry id for the `entries` collection, so the current
    // version of this row has a page.
    expect(within(entryRow).getByRole('link')).toHaveAttribute(
      'href',
      '/universes/u1/entries/e-77',
    );

    // The universe singleton has no per-row page in this app; rather than
    // fabricate one, the row simply carries no link.
    const universeRow = screen.getByTestId('sync-conflict-row-c1');
    expect(within(universeRow).queryByRole('link')).toBeNull();
  });

  it('treats tableName and rowId as opaque text', async () => {
    // Neither is a uuid: `tableName` is a manifest collection name and the
    // universe singleton's `rowId` is the literal string 'universe' (D-14).
    vi.mocked(api).mockImplementation(dispatch({ [LIST_PATH]: [NEWER] }));

    renderList();

    const row = await screen.findByTestId('sync-conflict-row-c1');
    expect(within(row).getByText('universe', { selector: 'code' })).toBeInTheDocument();
  });

  it('restores the clicked row, and only that row', async () => {
    // Two rows, so "the right row" is a claim that can fail. The GET returns
    // both first and only the survivor afterwards, so the assertion covers the
    // RENDERED outcome as well as the endpoint — a mutation that silently
    // failed would leave the row on screen.
    let listCall = 0;
    vi.mocked(api).mockImplementation(
      dispatch({
        [LIST_PATH]: () => (listCall++ === 0 ? [NEWER, OLDER] : [NEWER]),
        'POST /sync/conflicts/c2/restore': { ...OLDER, resolvedAt: '2026-08-04T13:00:00.000Z' },
        'POST /sync/conflicts/c2/resolve': { ...OLDER, resolvedAt: '2026-08-04T13:00:00.000Z' },
        'POST /sync/conflicts/c1/restore': { ...NEWER, resolvedAt: '2026-08-04T13:00:00.000Z' },
        'POST /sync/conflicts/c1/resolve': { ...NEWER, resolvedAt: '2026-08-04T13:00:00.000Z' },
      }),
    );

    renderList();

    const row = await screen.findByTestId('sync-conflict-row-c2');
    await userEvent.click(within(row).getByRole('button', { name: /restore/i }));

    // The endpoint, named positively: pointing restore at /resolve — which IS
    // routed above, so it would not fail on a missing route — dies here.
    await waitFor(() =>
      expect(api).toHaveBeenCalledWith(
        '/sync/conflicts/c2/restore',
        expect.objectContaining({ method: 'POST' }),
      ),
    );
    expect(api).not.toHaveBeenCalledWith(
      '/sync/conflicts/c1/restore',
      expect.objectContaining({ method: 'POST' }),
    );
    // …and the rendered outcome, so a mutation that threw cannot pass.
    await waitFor(() => expect(screen.queryByTestId('sync-conflict-row-c2')).toBeNull());
    expect(screen.getByTestId('sync-conflict-row-c1')).toBeInTheDocument();
  });

  it('dismisses the clicked row through /resolve, and only that row', async () => {
    let listCall = 0;
    vi.mocked(api).mockImplementation(
      dispatch({
        [LIST_PATH]: () => (listCall++ === 0 ? [NEWER, OLDER] : [OLDER]),
        'POST /sync/conflicts/c1/resolve': { ...NEWER, resolvedAt: '2026-08-04T13:00:00.000Z' },
        'POST /sync/conflicts/c1/restore': { ...NEWER, resolvedAt: '2026-08-04T13:00:00.000Z' },
        'POST /sync/conflicts/c2/resolve': { ...OLDER, resolvedAt: '2026-08-04T13:00:00.000Z' },
        'POST /sync/conflicts/c2/restore': { ...OLDER, resolvedAt: '2026-08-04T13:00:00.000Z' },
      }),
    );

    renderList();

    const row = await screen.findByTestId('sync-conflict-row-c1');
    await userEvent.click(within(row).getByRole('button', { name: /dismiss/i }));

    await waitFor(() =>
      expect(api).toHaveBeenCalledWith(
        '/sync/conflicts/c1/resolve',
        expect.objectContaining({ method: 'POST' }),
      ),
    );
    expect(api).not.toHaveBeenCalledWith(
      '/sync/conflicts/c2/resolve',
      expect.objectContaining({ method: 'POST' }),
    );
    await waitFor(() => expect(screen.queryByTestId('sync-conflict-row-c1')).toBeNull());
    expect(screen.getByTestId('sync-conflict-row-c2')).toBeInTheDocument();
  });

  it('says so when there are no conflicts', async () => {
    vi.mocked(api).mockImplementation(dispatch({ [LIST_PATH]: [] }));

    renderList();

    expect(await screen.findByTestId('sync-conflicts-empty')).toBeInTheDocument();
    expect(screen.queryByRole('listitem')).toBeNull();
  });

  it('renders a list failure through SYNC_ERROR_COPY', async () => {
    const forbidden = new ApiError(403, { error: 'forbidden', code: 'forbidden' }, 'forbidden');
    vi.mocked(api).mockImplementation(dispatch({ [LIST_PATH]: forbidden }));

    renderList();

    const notice = await screen.findByTestId('sync-conflicts-list-error');
    // Asserted against the copy module, never retyped: a retyped string passes
    // against a component that hardcoded its own prose.
    expect(notice).toHaveTextContent(SYNC_ERROR_COPY.forbidden.message);
  });

  it('renders a restore failure on the row it belongs to, through SYNC_ERROR_COPY', async () => {
    const missing = new ApiError(
      404,
      { error: 'not found', code: 'remote-universe-missing' },
      'universe missing on remote',
    );
    vi.mocked(api).mockImplementation(
      dispatch({
        [LIST_PATH]: [NEWER, OLDER],
        'POST /sync/conflicts/c1/restore': missing,
      }),
    );

    renderList();

    const row = await screen.findByTestId('sync-conflict-row-c1');
    await userEvent.click(within(row).getByRole('button', { name: /restore/i }));

    const notice = await screen.findByTestId('sync-conflict-error-c1');
    expect(notice).toHaveTextContent(SYNC_ERROR_COPY['remote-universe-missing'].message);
    // The failure belongs to the row the user acted on — not to the surface.
    expect(screen.queryByTestId('sync-conflict-error-c2')).toBeNull();
    // The row is still there to try again on.
    expect(screen.getByTestId('sync-conflict-row-c1')).toBeInTheDocument();
  });
});
