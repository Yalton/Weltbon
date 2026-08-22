/**
 * SyncTab tests — Plan F (Task 3), the universe-scoped Sync tab.
 *
 * Pins the three decisions this component implements:
 *   - F-01: links live per universe (this tab), remotes per account.
 *   - F-02: "Sync now" blocks inline; a `busy` failure offers Run anyway.
 *   - F-06: elapsed seconds, never synthetic progress, plus a first-sync
 *     warning for a link that has never completed a run.
 * …and the honest-reporting rules: `assetsUnrepairable` stated plainly,
 * `assetsRepairedLocally` never as an exact figure.
 *
 * Error prose is asserted against SYNC_ERROR_COPY, never retyped. A test that
 * retyped it would pass against a component that hardcoded its own string, and
 * would break on every deliberate copy edit.
 *
 * NEGATIVE ASSERTIONS USE APOSTROPHE-FREE PHRASES. This component renders
 * typographic apostrophes (&rsquo;, U+2019), so a `queryByText(/can't/)` with a
 * straight quote can never match and would pass no matter what the component
 * did. Every `not.toBeInTheDocument` below matches a phrase containing no
 * apostrophe at all.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor, within, act, fireEvent } from '@testing-library/react';
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
import { SyncTab } from './SyncTab';
import { makeApiDispatcher, type ApiHandler } from '../test/apiDispatcher';

function makeClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
}

function renderTab(universeId = 'u1') {
  // MemoryRouter because the tab deep-links to /settings/sync — the F-01 split
  // is only usable if the account-scoped surface is one click away.
  return render(
    <QueryClientProvider client={makeClient()}>
      <MemoryRouter>
        <SyncTab universeId={universeId} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const REMOTE = {
  id: 'r1',
  label: 'Laptop',
  baseUrl: 'http://localhost:3001',
  patSuffix: '4f2a',
  createdAt: '2026-08-01T00:00:00.000Z',
};

const LINK = {
  id: 'l1',
  universeId: 'u1',
  remoteId: 'r1',
  remoteLabel: 'Laptop',
  remoteBaseUrl: 'http://localhost:3001',
  status: 'idle',
  lastSyncedAt: '2026-08-03T00:00:00.000Z',
  lastError: null as string | null,
  createdAt: '2026-08-01T00:00:00.000Z',
};

const RESULT = {
  linkId: 'l1',
  bootstrapped: false,
  conflicts: 0,
  blobsPushed: 0,
  blobsPulled: 0,
  assetsRepairedLocally: 0,
  assetsRepairedOnPeer: 0,
  assetsSweptOnPeer: 0,
  assetsUnrepairable: 0,
  pushed: { upserted: {}, deleted: {} },
  appliedLocally: { upserted: {}, deleted: {} },
};

const LINKS_PATH = '/sync/links?universeId=u1';
const CONFLICTS_PATH = '/sync/conflicts?universeId=u1';

/**
 * The three GETs every render makes, plus whatever the test adds.
 *
 * ONE helper rather than a `routes()` object passed to a separate
 * `makeApiDispatcher()`: the two-step form invites
 * `makeApiDispatcher(extra, links)`, whose second argument is silently dropped,
 * leaving every GET "unhandled" and the component rendering a load error
 * instead of the state under test. That mistake was made here once already.
 *
 * CONFLICTS_PATH DEFAULTS TO EMPTY, NOT OMITTED. `SyncTab` embeds
 * `SyncConflictList`, which makes its own GET; leaving it unrouted made
 * `makeApiDispatcher` reject that call in all 22 tests here, so the embedded
 * component was exercised only in its error state and never its healthy one.
 * `extra` can still override this per test to reach the error or loading path
 * on purpose.
 */
function dispatch(extra: Record<string, ApiHandler> = {}, links: unknown[] = [LINK]) {
  return makeApiDispatcher({
    '/sync/remotes': [REMOTE],
    [LINKS_PATH]: links,
    [CONFLICTS_PATH]: [],
    ...extra,
  });
}

/** A run that never settles, so the in-flight UI stays on screen. */
const hangingRun = () => new Promise<never>(() => {});

// Braces matter — the concise form returns the mock, which vitest would then
// run as a teardown callback and call api() with no arguments.
beforeEach(() => {
  vi.mocked(api).mockReset();
});

// A test that times out inside a `try` never reaches its `finally`, and a
// leaked fake clock hangs every test after it — turning one failure into a
// file-wide cascade that hides which test actually broke.
afterEach(() => {
  vi.useRealTimers();
});

describe('SyncTab — the link list', () => {
  it('lists each linked remote by label and address', async () => {
    vi.mocked(api).mockImplementation(dispatch());

    renderTab();

    expect(await screen.findByText('Laptop')).toBeInTheDocument();
    expect(screen.getByText('http://localhost:3001')).toBeInTheDocument();
  });

  it('renders a persisted lastError through lastErrorMessage, detail and all', async () => {
    // WHY THE DETAIL MATTERS. `blob-unavailable`'s `side` — which instance is
    // missing the bytes — is NOT on the wire; the run route serializes only
    // {error, code}. The server writes it into `sync_links.last_error`, so this
    // rendered detail is the only path by which the remedy reaches the user.
    vi.mocked(api).mockImplementation(
      dispatch(
        {},
        [{ ...LINK, status: 'error', lastError: 'blob-unavailable: missing on both instances (3 files)' }],
      ),
    );

    renderTab();

    const box = await screen.findByTestId('sync-link-last-error-l1');
    expect(box).toHaveTextContent(SYNC_ERROR_COPY['blob-unavailable'].message);
    expect(box).toHaveTextContent(/both instances/);
  });

  it('shows an empty state when the universe has no links', async () => {
    vi.mocked(api).mockImplementation(dispatch({}, []));

    renderTab();

    expect(await screen.findByText(/not linked/i)).toBeInTheDocument();
  });

  it('does not claim the universe has no links when the list failed to load', async () => {
    // On a hard failure `data` is `undefined`, so a `linked.length === 0` gate
    // that ignores `listError` renders "This universe is not linked to any
    // remote instance yet" DIRECTLY BENEATH the error notice — an active claim
    // about a list the client never actually saw. `SyncConflictList` already
    // stays silent for this exact reason (its own list-error test); this list
    // must too.
    const forbidden = new ApiError(403, { error: 'forbidden', code: 'forbidden' }, 'forbidden');
    vi.mocked(api).mockImplementation(
      makeApiDispatcher({
        '/sync/remotes': [REMOTE],
        [LINKS_PATH]: forbidden,
        [CONFLICTS_PATH]: [],
      }),
    );

    renderTab();

    // Positive precondition: the failure really did render, so the absence
    // below is not the absence of everything.
    await screen.findByTestId('sync-links-list-error');
    // Apostrophe-free, so it can actually match if it is ever rendered.
    expect(screen.queryByText(/not linked to any remote instance/i)).not.toBeInTheDocument();
  });
});

describe('SyncTab — #44 auto-sync toggle and status', () => {
  it('PATCHes autoSync when the checkbox is toggled', async () => {
    vi.mocked(api).mockImplementation(
      dispatch(
        { 'PATCH /sync/links/l1': { ...LINK, autoSync: false } },
        [{ ...LINK, autoSync: true }],
      ),
    );
    const user = userEvent.setup();

    renderTab();
    const checkbox = await screen.findByRole('checkbox', { name: /auto-sync with laptop/i });
    expect(checkbox).toBeChecked();

    await user.click(checkbox);

    await waitFor(() =>
      expect(api).toHaveBeenCalledWith(
        '/sync/links/l1',
        expect.objectContaining({ method: 'PATCH' }),
      ),
    );
    const call = vi
      .mocked(api)
      .mock.calls.find(([p, i]) => p === '/sync/links/l1' && (i as RequestInit | undefined)?.method === 'PATCH');
    expect(JSON.parse(String((call![1] as RequestInit).body))).toEqual({ autoSync: false });
  });

  it('shows the paused remedy and keeps Sync now enabled so a manual run can clear it', async () => {
    // AS-08: a successful manual run is one of the three ways a user escapes a
    // pause, so the button must never be disabled here.
    //
    // WHAT THIS TEST DOES AND DOES NOT PROVE. It asserts the button is
    // reachable, and nothing more — the run itself, and the clear that follows
    // it, are server-side. That distinction is not pedantic: the clear did not
    // exist until the #44 whole-branch review, this test passed the entire
    // time, and the pause was inescapable in practice. The API-side proof is
    // in api/tests/sync-auto.test.ts ("a successful manual run clears…").
    vi.mocked(api).mockImplementation(
      dispatch({}, [{ ...LINK, status: 'error', pausedReason: 'remote-unauthorized' }]),
    );

    renderTab();

    const status = await screen.findByTestId('sync-link-status-l1');
    expect(status).toHaveTextContent(/sign in/i);
    // Not a time (FIX 6): the row HAS a lastSyncedAt, but this sentence is a
    // remedy, not a timestamp, and wrapping it in <time dateTime> announces a
    // datetime that has nothing to do with what is being read out.
    expect(status.querySelector('time')).toBeNull();
    expect(screen.getByRole('button', { name: /sync now/i })).toBeEnabled();
  });

  it('names the backoff wait instead of implying the link is broken', async () => {
    vi.mocked(api).mockImplementation(
      dispatch(
        {},
        [
          {
            ...LINK,
            autoSync: true,
            failureCount: 2,
            nextPollAt: new Date(Date.now() + 5 * 60_000).toISOString(),
          },
        ],
      ),
    );

    renderTab();

    const status = await screen.findByTestId('sync-link-status-l1');
    expect(status).toHaveTextContent(/retrying in/i);
    expect(status.querySelector('time')).toBeNull(); // FIX 6 — not a timestamp
  });

  it('marks up the last-synced line, and only that line, as a <time>', async () => {
    vi.mocked(api).mockImplementation(dispatch({}, [{ ...LINK, autoSync: true }]));

    renderTab();

    const status = await screen.findByTestId('sync-link-status-l1');
    expect(status).toHaveTextContent(/^Synced /);
    const time = status.querySelector('time');
    expect(time).not.toBeNull();
    expect(time).toHaveAttribute('dateTime', LINK.lastSyncedAt);
  });
});

describe('SyncTab — F-06, a run in flight', () => {
  it('shows elapsed time, and warns about a slow FIRST sync', async () => {
    vi.mocked(api).mockImplementation(
      dispatch(
        { 'POST /sync/links/l1/run': hangingRun },
        [{ ...LINK, lastSyncedAt: null }],
      ),
    );
    const user = userEvent.setup();

    renderTab();
    await user.click(await screen.findByRole('button', { name: /sync now/i }));

    // Elapsed seconds — a real measured number, not a synthetic percentage.
    expect(await screen.findByTestId('sync-link-elapsed-l1')).toHaveTextContent(/\d+s/);
    // Apostrophe-free phrase on purpose — see the file docstring.
    expect(screen.getByText(/can take several minutes/i)).toBeInTheDocument();
  });

  it('does NOT warn about a first sync once the link has synced before', async () => {
    vi.mocked(api).mockImplementation(
      dispatch({ 'POST /sync/links/l1/run': hangingRun }),
    );
    const user = userEvent.setup();

    renderTab();
    await user.click(await screen.findByRole('button', { name: /sync now/i }));

    // The run IS in flight — assert that first, or a component that never
    // started would pass this test for the wrong reason.
    expect(await screen.findByTestId('sync-link-elapsed-l1')).toBeInTheDocument();
    expect(screen.queryByText(/can take several minutes/i)).not.toBeInTheDocument();
  });
});

describe('SyncTab — F-02, the blocking run', () => {
  it('reports assetsUnrepairable as a warning on an otherwise successful run', async () => {
    vi.mocked(api).mockImplementation(
      dispatch({ 'POST /sync/links/l1/run': { ...RESULT, assetsUnrepairable: 2 } }),
    );
    const user = userEvent.setup();

    renderTab();
    await user.click(await screen.findByRole('button', { name: /sync now/i }));

    const summary = await screen.findByTestId('sync-link-result-l1');
    // The NUMBER, not merely the fact — an "some files" message would hide
    // whether one file or two hundred are unrecoverable.
    expect(summary).toHaveTextContent(/2 asset files could not be restored/i);
  });

  it('says nothing about unrepairable assets when there are none', async () => {
    vi.mocked(api).mockImplementation(
      dispatch({ 'POST /sync/links/l1/run': { ...RESULT, assetsUnrepairable: 0 } }),
    );
    const user = userEvent.setup();

    renderTab();
    await user.click(await screen.findByRole('button', { name: /sync now/i }));

    await screen.findByTestId('sync-link-result-l1');
    // Apostrophe-free phrase — see the file docstring.
    expect(screen.queryByText(/asset files could not be restored/i)).not.toBeInTheDocument();
  });

  it('never states an exact figure for assetsRepairedLocally', async () => {
    // The counter counts PLANNED restores and is known to undercount, so a
    // precise "restored 7 files" would be a number the user could disprove.
    vi.mocked(api).mockImplementation(
      dispatch({ 'POST /sync/links/l1/run': { ...RESULT, assetsRepairedLocally: 7 } }),
    );
    const user = userEvent.setup();

    renderTab();
    await user.click(await screen.findByRole('button', { name: /sync now/i }));

    const summary = await screen.findByTestId('sync-link-result-l1');
    expect(summary).toHaveTextContent(/restored/i);
    expect(summary).not.toHaveTextContent('7');
  });

  it('offers Run anyway for a busy failure, and forces the retry', async () => {
    const busy = new ApiError(409, { error: 'sync already running', code: 'busy' }, 'sync already running');
    let call = 0;
    vi.mocked(api).mockImplementation(
      dispatch({
        'POST /sync/links/l1/run': () => {
          call += 1;
          return call === 1 ? Promise.reject(busy) : RESULT;
        },
        'POST /sync/links/l1/run?force=true': () => {
          call += 1;
          return RESULT;
        },
      }),
    );
    const user = userEvent.setup();

    renderTab();
    await user.click(await screen.findByRole('button', { name: /sync now/i }));

    const box = await screen.findByTestId('sync-link-run-error-l1');
    expect(box).toHaveTextContent(SYNC_ERROR_COPY.busy.message);

    // The recovery path for a claim left stuck by a closed tab: the server
    // lease is 30 minutes, so without force the link is wedged for that long.
    await user.click(screen.getByRole('button', { name: /run anyway/i }));

    await waitFor(() =>
      expect(api).toHaveBeenCalledWith(
        '/sync/links/l1/run?force=true',
        expect.objectContaining({ method: 'POST' }),
      ),
    );
  });

  it('does NOT offer Run anyway for a failure that forcing cannot fix', async () => {
    const unreachable = new ApiError(
      502,
      { error: 'remote unreachable', code: 'remote-unreachable' },
      'connect ECONNREFUSED',
    );
    vi.mocked(api).mockImplementation(
      dispatch({ 'POST /sync/links/l1/run': unreachable }),
    );
    const user = userEvent.setup();

    renderTab();
    await user.click(await screen.findByRole('button', { name: /sync now/i }));

    const box = await screen.findByTestId('sync-link-run-error-l1');
    expect(box).toHaveTextContent(SYNC_ERROR_COPY['remote-unreachable'].message);
    expect(screen.queryByRole('button', { name: /run anyway/i })).not.toBeInTheDocument();
  });
});

describe('SyncTab — linking a remote', () => {
  it('POSTs {universeId, remoteId} for the chosen remote', async () => {
    vi.mocked(api).mockImplementation(
      dispatch({ 'POST /sync/links': { ...LINK, id: 'l2' } }, []),
    );
    const user = userEvent.setup();

    renderTab();

    const select = await screen.findByLabelText(/remote to link/i);
    await user.selectOptions(select, 'r1');
    await user.click(screen.getByRole('button', { name: /^link universe$/i }));

    await waitFor(() => {
      const call = vi
        .mocked(api)
        .mock.calls.find(([p, i]) => p === '/sync/links' && (i as RequestInit | undefined)?.method === 'POST');
      expect(call).toBeDefined();
      expect(JSON.parse(String((call![1] as RequestInit).body))).toEqual({
        universeId: 'u1',
        remoteId: 'r1',
      });
    });
  });

  it('points at account settings when there are no remotes to link', async () => {
    // F-01's split made visible: a remote is registered once per account, so a
    // user with none must be sent to the OTHER surface, not offered a form.
    vi.mocked(api).mockImplementation(dispatch({ '/sync/remotes': [] }, []));

    renderTab();

    expect(await screen.findByText(/no sync remotes/i)).toBeInTheDocument();
  });

  it('does not claim every remote is linked when the remotes list failed to load', async () => {
    // On a hard failure `remotes` is `undefined`, so `available.length === 0`
    // is (vacuously) true and a gate that ignores the error renders "Every
    // saved remote is already linked to this universe" — a confident, false
    // sentence, with the real error not shown and no way to link anything.
    const forbidden = new ApiError(403, { error: 'forbidden', code: 'forbidden' }, 'forbidden');
    vi.mocked(api).mockImplementation(
      makeApiDispatcher({
        '/sync/remotes': forbidden,
        [LINKS_PATH]: [LINK],
        [CONFLICTS_PATH]: [],
      }),
    );

    renderTab();

    // Positive precondition: the failure really did render.
    await screen.findByTestId('sync-remotes-list-error');
    // Apostrophe-free, so it can actually match if it is ever rendered.
    expect(screen.queryByText(/already linked to this universe/i)).not.toBeInTheDocument();
  });
});

describe('SyncTab — the persisted lastError reaches the user after a failure', () => {
  it('merges the refetched lastError detail into the thrown run error', async () => {
    // THE PAYOFF OF `onSettled`, and the reason invalidating on failure is not
    // merely tidy. `blob-unavailable`'s `side` — WHICH instance is missing the
    // bytes — is not on the wire; the route serializes only {error, code}. The
    // thrown copy therefore knows a COUNT ("3 content hash(es)") and no remedy.
    // Naming the side exists only in `sync_links.last_error`, which the server
    // writes before returning the error and which the refetch pulls in.
    //
    // Suppressing the persisted copy whenever a run had happened this session
    // made the refetch invisible: it fired, the cache updated, and the user was
    // still never told which side to fix.
    const thrown = new ApiError(
      409,
      { error: 'asset bytes unavailable', code: 'blob-unavailable' },
      'Asset bytes unavailable for 3 content hash(es)',
    );
    let listCall = 0;
    vi.mocked(api).mockImplementation(
      makeApiDispatcher({
        '/sync/remotes': [REMOTE],
        [LINKS_PATH]: () => {
          listCall += 1;
          // The row the failed run left behind, as onSettled's refetch sees it.
          return listCall === 1
            ? [LINK]
            : [
                {
                  ...LINK,
                  status: 'error',
                  lastError: 'blob-unavailable: 3 asset blob(s) unavailable on this instance',
                },
              ];
        },
        [CONFLICTS_PATH]: [],
        'POST /sync/links/l1/run': thrown,
      }),
    );
    const user = userEvent.setup();

    renderTab();
    await user.click(await screen.findByRole('button', { name: /sync now/i }));

    const box = await screen.findByTestId('sync-link-run-error-l1');
    expect(box).toHaveTextContent(SYNC_ERROR_COPY['blob-unavailable'].message);
    // The remedy — which side to fix — arrives only via the refetched column.
    await waitFor(() => expect(box).toHaveTextContent(/unavailable on this instance/i));
    // …and the thrown error's own count survives the merge; the column has no
    // count and the wire has no side, so the user needs both halves.
    expect(box).toHaveTextContent(/3 content hash/i);
  });

  it('does not attach an older failure’s detail to a different one', async () => {
    // The merge is gated on the two copies naming the same code. A stale
    // `remote-unreachable` still sitting in the column must not decorate a
    // fresh `busy`, or the UI invents a diagnosis.
    const busy = new ApiError(409, { error: 'busy', code: 'busy' }, 'sync already running');
    vi.mocked(api).mockImplementation(
      makeApiDispatcher({
        '/sync/remotes': [REMOTE],
        [LINKS_PATH]: [
          { ...LINK, lastError: 'remote-unreachable: connect ECONNREFUSED 10.0.0.4:3001' },
        ],
        [CONFLICTS_PATH]: [],
        'POST /sync/links/l1/run': busy,
      }),
    );
    const user = userEvent.setup();

    renderTab();
    await user.click(await screen.findByRole('button', { name: /sync now/i }));

    const box = await screen.findByTestId('sync-link-run-error-l1');
    expect(box).toHaveTextContent(SYNC_ERROR_COPY.busy.message);
    expect(box).not.toHaveTextContent(/ECONNREFUSED/);
  });
});

describe('SyncTab — F-06, the elapsed count is real', () => {
  it('counts upward as the run continues', async () => {
    // A literal "0s" with no ticking satisfies a /\d+s/ assertion perfectly —
    // and a frozen display is exactly the synthetic progress F-06 forbids,
    // because it makes a working slow run indistinguishable from a hang.
    // Observing the value ADVANCE is the only assertion that rules it out.
    vi.mocked(api).mockImplementation(dispatch({ 'POST /sync/links/l1/run': hangingRun }));

    renderTab();
    // Resolve the initial load on REAL timers. RTL's async queries drive their
    // own polling loop, and doing that under a faked clock is a deadlock hunt
    // with nothing to do with what this test asserts.
    const button = await screen.findByRole('button', { name: /sync now/i });

    // `toFake` explicitly: this test needs a faked `Date` as much as a faked
    // `setInterval`, because the counter is `Date.now() - startedAt`. Vitest
    // fakes Date by default, but if that default is ever narrowed in config the
    // display sticks at 0s and the failure gives no hint why.
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    try {
      // fireEvent, not userEvent: userEvent schedules timers of its own between
      // the events it synthesises, which under a faked clock needs an advance
      // callback wired through. A bare click is all this test needs.
      fireEvent.click(button);
      expect(screen.getByTestId('sync-link-elapsed-l1')).toHaveTextContent(/^0s$/);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(3000);
      });
      expect(screen.getByTestId('sync-link-elapsed-l1')).toHaveTextContent(/^3s$/);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(4000);
      });
      expect(screen.getByTestId('sync-link-elapsed-l1')).toHaveTextContent(/^7s$/);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('SyncTab — F-06, the first-sync warning is captured at run start', () => {
  it('keeps the warning for the run it describes when the row refetches mid-run', async () => {
    // WHY CAPTURED AND NOT READ LIVE. Both links share one query key, so when
    // the second link's run settles it invalidates and refetches BOTH rows. If
    // the server has already recorded the first link's run — this tab is still
    // waiting on a response that is slow or lost — the refetched row says
    // "synced", while the user is still sitting in front of a run that began
    // with nothing synced. Reading live would yank the explanation for the wait
    // away mid-wait, which is the confusion F-06 exists to prevent.
    const A = { ...LINK, id: 'la', remoteId: 'ra', remoteLabel: 'Laptop', lastSyncedAt: null };
    const B = {
      ...LINK,
      id: 'lb',
      remoteId: 'rb',
      remoteLabel: 'Desktop',
      lastSyncedAt: '2026-08-03T00:00:00.000Z',
    };
    let listCall = 0;
    vi.mocked(api).mockImplementation(
      makeApiDispatcher({
        '/sync/remotes': [REMOTE],
        [LINKS_PATH]: () => {
          listCall += 1;
          return listCall === 1
            ? [A, B]
            : [{ ...A, lastSyncedAt: '2026-08-04T00:00:00.000Z' }, B];
        },
        [CONFLICTS_PATH]: [],
        'POST /sync/links/la/run': hangingRun,
        'POST /sync/links/lb/run': { ...RESULT, linkId: 'lb' },
      }),
    );
    const user = userEvent.setup();

    renderTab();
    await user.click(await screen.findByRole('button', { name: /sync now with Laptop/i }));
    expect(screen.getByText(/can take several minutes/i)).toBeInTheDocument();

    // The second link's run settles, invalidating the key both rows share.
    await user.click(screen.getByRole('button', { name: /sync now with Desktop/i }));

    const rowA = screen.getByTestId('sync-link-row-la');
    // The refetch has LANDED — A's own meta line reads the live row, which now
    // says it has synced. Without this the test could pass before any refetch.
    await waitFor(() => expect(within(rowA).queryByText('Never synced')).toBeNull());

    // …and the warning, captured when this run started, is still on screen.
    expect(within(rowA).getByText(/can take several minutes/i)).toBeInTheDocument();
  });
});

describe('SyncTab — the remote list while it is still loading', () => {
  it('makes no claim about remotes before they arrive', async () => {
    // `remotes` is `undefined` mid-fetch, so `remotes.length === 0` is falsy
    // and a naive branch order shows "Every saved remote is already linked to
    // this universe" — a complete, confident sentence about a list nobody has
    // seen yet.
    vi.mocked(api).mockImplementation(
      makeApiDispatcher({
        '/sync/remotes': () => new Promise(() => {}),
        [LINKS_PATH]: [LINK],
        [CONFLICTS_PATH]: [],
      }),
    );

    renderTab();

    // The links HAVE arrived, so the page is rendered and only the remotes are
    // outstanding — the exact window the false claim appeared in.
    await screen.findByTestId('sync-link-row-l1');
    expect(screen.queryByText(/already linked to this universe/i)).not.toBeInTheDocument();
    expect(screen.getByLabelText('Loading sync remotes')).toBeInTheDocument();
  });
});

describe('SyncTab — a failure the run response cannot explain', () => {
  it('still shows the column diagnosis when the thrown error carries no code', async () => {
    // THE COMMONEST SHAPE OF THIS FAILURE, and the one the first fix missed.
    // A multi-minute blocking request most often dies in transit — proxy
    // timeout, dropped connection — which is not an ApiError at all, so
    // `syncErrorMessage` returns the generic sentence with no code. The server
    // still recorded what went wrong, `onSettled` still refetches it, and
    // suppressing the column because "a run happened this session" threw that
    // away: the user saw "Something went wrong while talking to the server"
    // while `remote-quota-exceeded` sat unread one field over.
    let listCall = 0;
    vi.mocked(api).mockImplementation(
      makeApiDispatcher({
        '/sync/remotes': [REMOTE],
        [LINKS_PATH]: () => {
          listCall += 1;
          return listCall === 1
            ? [LINK]
            : [
                {
                  ...LINK,
                  status: 'error',
                  lastError: 'remote-quota-exceeded: remote reported 0 bytes free',
                },
              ];
        },
        [CONFLICTS_PATH]: [],
        'POST /sync/links/l1/run': new TypeError('Failed to fetch'),
      }),
    );
    const user = userEvent.setup();

    renderTab();
    await user.click(await screen.findByRole('button', { name: /sync now/i }));

    // The generic sentence is shown — it is all the thrown value supports…
    await screen.findByTestId('sync-link-run-error-l1');
    // …and the refetched column's real diagnosis is shown too, separately,
    // because no code was established on the thrown side to merge it onto.
    const box = await screen.findByTestId('sync-link-last-error-l1');
    expect(box).toHaveTextContent(SYNC_ERROR_COPY['remote-quota-exceeded'].message);
    expect(box).toHaveTextContent(/0 bytes free/);
  });

  it('does not repeat the column when it WAS merged into the run error', async () => {
    // The other half of the rule: a same-code column is folded in, so showing
    // it again as its own notice would print the same sentence twice.
    const thrown = new ApiError(
      409,
      { error: 'asset bytes unavailable', code: 'blob-unavailable' },
      'Asset bytes unavailable for 3 content hash(es)',
    );
    vi.mocked(api).mockImplementation(
      makeApiDispatcher({
        '/sync/remotes': [REMOTE],
        [LINKS_PATH]: [
          { ...LINK, lastError: 'blob-unavailable: 3 asset blob(s) unavailable on this instance' },
        ],
        [CONFLICTS_PATH]: [],
        'POST /sync/links/l1/run': thrown,
      }),
    );
    const user = userEvent.setup();

    renderTab();
    await user.click(await screen.findByRole('button', { name: /sync now/i }));

    const box = await screen.findByTestId('sync-link-run-error-l1');
    await waitFor(() => expect(box).toHaveTextContent(/unavailable on this instance/i));
    expect(screen.queryByTestId('sync-link-last-error-l1')).not.toBeInTheDocument();
  });
});

describe('SyncTab — removing a link', () => {
  /** Open the confirm dialog for a row and press its destructive button. */
  async function confirmRemoval(user: ReturnType<typeof userEvent.setup>, name: RegExp) {
    await user.click(await screen.findByRole('button', { name }));
    await user.click(await screen.findByRole('button', { name: /^remove link$/i }));
  }

  it('DELETEs the link the dialog named', async () => {
    let listCall = 0;
    vi.mocked(api).mockImplementation(
      makeApiDispatcher({
        '/sync/remotes': [REMOTE],
        [LINKS_PATH]: () => {
          listCall += 1;
          return listCall === 1 ? [LINK] : [];
        },
        [CONFLICTS_PATH]: [],
        'DELETE /sync/links/l1': { deleted: true },
      }),
    );
    const user = userEvent.setup();

    renderTab();
    await confirmRemoval(user, /remove link to Laptop/i);

    await waitFor(() =>
      expect(api).toHaveBeenCalledWith(
        '/sync/links/l1',
        expect.objectContaining({ method: 'DELETE' }),
      ),
    );
    // The row is gone once the invalidated list comes back empty.
    await waitFor(() => expect(screen.queryByTestId('sync-link-row-l1')).not.toBeInTheDocument());
  });

  it('reports a failed removal beside the list, not as a create error', async () => {
    // A failed removal used to write to the ADD form's error slot: the dialog
    // closed (reading as success) and the explanation appeared under "Remote to
    // link", labelled a create error, possibly below the fold.
    const denied = new ApiError(
      403,
      { error: 'not your universe', code: 'forbidden' },
      'not your universe',
    );
    vi.mocked(api).mockImplementation(
      makeApiDispatcher({
        '/sync/remotes': [REMOTE],
        [LINKS_PATH]: [LINK],
        [CONFLICTS_PATH]: [],
        'DELETE /sync/links/l1': denied,
      }),
    );
    const user = userEvent.setup();

    renderTab();
    await confirmRemoval(user, /remove link to Laptop/i);

    const box = await screen.findByTestId('sync-link-remove-error');
    expect(box).toHaveTextContent(SYNC_ERROR_COPY.forbidden.message);
    expect(screen.queryByTestId('sync-link-create-error')).not.toBeInTheDocument();
    // …and the link is still there, because the server kept it.
    expect(screen.getByTestId('sync-link-row-l1')).toBeInTheDocument();
  });

  it('drops only the removed link’s run state, leaving other rows alone', async () => {
    // The cleanup at the end of onConfirm must not be a `setRuns({})`: another
    // link can be mid-run at that moment, and clearing the whole map would
    // erase its in-flight display — the elapsed counter and the first-sync
    // warning — while its request is still outstanding.
    const A = { ...LINK, id: 'la', remoteId: 'ra', remoteLabel: 'Laptop', lastSyncedAt: null };
    const B = { ...LINK, id: 'lb', remoteId: 'rb', remoteLabel: 'Desktop' };
    let listCall = 0;
    vi.mocked(api).mockImplementation(
      makeApiDispatcher({
        '/sync/remotes': [REMOTE],
        [LINKS_PATH]: () => {
          listCall += 1;
          return listCall === 1 ? [A, B] : [A];
        },
        [CONFLICTS_PATH]: [],
        'POST /sync/links/la/run': hangingRun,
        'DELETE /sync/links/lb': { deleted: true },
      }),
    );
    const user = userEvent.setup();

    renderTab();
    await user.click(await screen.findByRole('button', { name: /sync now with Laptop/i }));
    expect(await screen.findByTestId('sync-link-elapsed-la')).toBeInTheDocument();

    await confirmRemoval(user, /remove link to Desktop/i);

    await waitFor(() => expect(screen.queryByTestId('sync-link-row-lb')).not.toBeInTheDocument());
    // A's run is still in flight and still says so.
    expect(screen.getByTestId('sync-link-elapsed-la')).toBeInTheDocument();
    expect(screen.getByText(/can take several minutes/i)).toBeInTheDocument();
  });
});

describe('SyncTab — the embedded conflict list', () => {
  it('routes /sync/conflicts so the embedded list renders healthy, not its error state', async () => {
    // Before CONFLICTS_PATH existed, every dispatcher call in this file left
    // `/sync/conflicts` unrouted, which `makeApiDispatcher` rejects — so the
    // embedded `SyncConflictList` was in its error state in all 22 tests here,
    // and the composition was never exercised in its ordinary, healthy state.
    vi.mocked(api).mockImplementation(dispatch());

    renderTab();

    expect(await screen.findByTestId('sync-conflicts-empty')).toBeInTheDocument();
    expect(screen.queryByTestId('sync-conflicts-list-error')).not.toBeInTheDocument();
  });

  it('renders a real conflict row when the route returns one', async () => {
    const conflict = {
      id: 'c1',
      universeId: 'u1',
      tableName: 'entries',
      rowId: 'e1',
      winner: 'local',
      loserPayload: { name: 'Replaced name' },
      resolvedAt: null as string | null,
      createdAt: '2026-08-01T00:00:00.000Z',
    };
    vi.mocked(api).mockImplementation(dispatch({ [CONFLICTS_PATH]: [conflict] }));

    renderTab();

    expect(await screen.findByTestId('sync-conflict-row-c1')).toBeInTheDocument();
  });
});
