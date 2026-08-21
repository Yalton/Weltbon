/**
 * OB-01 / OB-04. The one-button connect flow (#42).
 *
 * Sequences four calls that already exist. Each one goes to the LOCAL api,
 * which dials the peer server-side — the browser cannot dial the peer, because
 * the hosted instance admits only its own origin via CORS (#27).
 *
 * Failure never rolls back. The failed step is remembered and retry() resumes
 * there, reusing what earlier steps produced. This is why POST /remotes is
 * idempotent (OB-03): a retry must not strand another remote.
 */
import { useCallback, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../api/client';
import { SYNC_REMOTES_QUERY_KEY } from './syncKeys';
import type { RemoteUniverse } from './useAdoptUniverse';
import type { SyncRemote } from './useSyncRemotes';

export type ConnectStep =
  | 'authenticating' | 'discovering' | 'choosing' | 'adopting' | 'syncing' | 'done';

export interface ConnectState {
  step: ConnectStep | 'idle';
  failedStep: ConnectStep | null;
  error: { message: string; code?: string } | null;
  universes: RemoteUniverse[];
  remoteId: string | null;
  linkId: string | null;
  universeId: string | null;
}

const INITIAL: ConnectState = {
  step: 'idle', failedStep: null, error: null,
  universes: [], remoteId: null, linkId: null, universeId: null,
};

/**
 * Read the server's `code` off a thrown error, regardless of which shape it
 * arrived in.
 *
 * `api()` (web/src/api/client.ts) throws `ApiError` for every non-2xx
 * response, and `ApiError` does NOT carry `code` as its own property — the
 * server puts `code` inside the JSON body (`{ error, code }`, see
 * api/src/routes/sync-client.ts:732 and friends), and `ApiError` stores that
 * whole body verbatim on `.body`, not spread onto the error instance. Reading
 * `err.code` directly (as an early draft of this hook did) is always
 * `undefined` against the real client, which would silently break both the
 * attribution tests below and the already-adopted recovery path in the
 * `adopting` step. Falling back to a bare `.code` property keeps this
 * tolerant of any other error shape a caller might throw.
 */
function errorCode(e: unknown): string | undefined {
  if (e instanceof ApiError) {
    const body = e.body as { code?: string } | null | undefined;
    return body?.code;
  }
  return (e as { code?: string } | null | undefined)?.code;
}

function toError(e: unknown): { message: string; code?: string } {
  const err = e as { message?: string } | null | undefined;
  return { message: err?.message ?? 'Something went wrong', code: errorCode(e) };
}

export function useConnectToWeltbon() {
  const qc = useQueryClient();
  const [state, setState] = useState<ConnectState>(INITIAL);
  // Credentials are held only for the duration of a flow, so a retry at a
  // later step never re-sends them. Cleared once step 1 succeeds.
  const creds = useRef<{ baseUrl: string; email: string; password: string } | null>(null);

  const runFrom = useCallback(async (from: ConnectStep, seed: ConnectState) => {
    let s = { ...seed, failedStep: null as ConnectStep | null, error: null as ConnectState['error'] };

    try {
      if (from === 'authenticating') {
        setState({ ...s, step: 'authenticating' });
        const c = creds.current;
        if (!c) throw new Error('Enter the address and your sign-in details first');
        const remote = await api<SyncRemote>('/sync/remotes', {
          method: 'POST',
          body: JSON.stringify({ baseUrl: c.baseUrl, email: c.email, password: c.password }),
        });
        creds.current = null;               // password's lifetime ends here
        qc.invalidateQueries({ queryKey: SYNC_REMOTES_QUERY_KEY });
        s = { ...s, remoteId: remote.id };
        from = 'discovering';
      }

      if (from === 'discovering') {
        setState({ ...s, step: 'discovering' });
        const { universes } = await api<{ universes: RemoteUniverse[] }>(
          `/sync/remotes/${s.remoteId}/universes`,
        );
        s = { ...s, universes };
        // A picker with one option asks a question with one answer.
        if (universes.length === 1) {
          s = { ...s, universeId: universes[0].id };
          from = 'adopting';
        } else {
          setState({ ...s, step: 'choosing' });
          return;
        }
      }

      if (from === 'adopting') {
        setState({ ...s, step: 'adopting' });
        try {
          const link = await api<{ id: string }>('/sync/adopt', {
            method: 'POST',
            body: JSON.stringify({ remoteId: s.remoteId, universeId: s.universeId }),
          });
          s = { ...s, linkId: link.id };
        } catch (e) {
          // OB-04. Re-entering adopt after it already succeeded (server
          // committed, response lost) throws rather than succeeding. Treating
          // it as a failure would strand the user forever, re-reporting a
          // failure for work that is done. Confirmed against
          // api/src/services/sync/run-errors.ts:206 — the class carries
          // `code = 'universe-already-local'` (hyphens), status 409.
          if (errorCode(e) !== 'universe-already-local') throw e;
          // GET /sync/links REQUIRES ?universeId= — it is universe-scoped
          // (F-01), not a global list.
          const links = await api<Array<{ id: string; universeId: string; remoteId: string }>>(
            `/sync/links?universeId=${encodeURIComponent(s.universeId!)}`,
          );
          const found = links.find((l) => l.remoteId === s.remoteId);
          if (!found) throw e;
          s = { ...s, linkId: found.id };
        }
        from = 'syncing';
      }

      if (from === 'syncing') {
        setState({ ...s, step: 'syncing' });
        await api(`/sync/links/${s.linkId}/run`, { method: 'POST' });
      }

      setState({ ...s, step: 'done' });
    } catch (e) {
      setState({ ...s, step: from, failedStep: from, error: toError(e) });
    }
  }, [qc]);

  const start = useCallback(async (args: { baseUrl: string; email: string; password: string }) => {
    creds.current = args;
    await runFrom('authenticating', INITIAL);
  }, [runFrom]);

  const chooseUniverse = useCallback(async (universeId: string) => {
    await runFrom('adopting', { ...state, universeId });
  }, [runFrom, state]);

  const retry = useCallback(async () => {
    if (!state.failedStep) return;
    await runFrom(state.failedStep, state);
  }, [runFrom, state]);

  return { ...state, start, chooseUniverse, retry };
}
