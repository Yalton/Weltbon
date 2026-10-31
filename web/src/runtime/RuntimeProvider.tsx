import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type PropsWithChildren,
} from 'react';
import { api, setAccessToken } from '../api/client';
import { useAuthStore } from '../store/auth';

export type AuthMode = 'local' | 'server';
export interface LandingConfig {
  inviteRequestsEnabled: boolean;
  repoUrl: string;
}
export interface RuntimeValue {
  authMode: AuthMode;
  landing: LandingConfig;
}

interface RuntimeCapabilities {
  authMode: AuthMode;
  landing: LandingConfig;
}

// Used when an older API omits `landing`: no invite form, public repo link.
const FALLBACK_LANDING: LandingConfig = {
  inviteRequestsEnabled: false,
  repoUrl: 'https://github.com/Yalton/Weltbon',
};

function parseLanding(raw: unknown): LandingConfig {
  if (typeof raw !== 'object' || raw === null) return FALLBACK_LANDING;
  const { inviteRequestsEnabled, repoUrl } = raw as Record<string, unknown>;
  return {
    inviteRequestsEnabled: inviteRequestsEnabled === true,
    repoUrl: typeof repoUrl === 'string' && /^https?:\/\//.test(repoUrl) ? repoUrl : FALLBACK_LANDING.repoUrl,
  };
}

interface MeResponse {
  id: string;
  email: string;
  displayName: string;
  isAdmin?: boolean;
}

interface RuntimeState {
  authMode: AuthMode | null;
  landing: LandingConfig;
  status: 'loading' | 'ready' | 'error';
}

const RuntimeContext = createContext<RuntimeValue | null>(null);

export function useRuntime(): RuntimeValue {
  const value = useContext(RuntimeContext);
  if (!value) throw new Error('useRuntime must be used inside RuntimeProvider');
  return value;
}

export function RuntimeProvider({ children }: PropsWithChildren) {
  const user = useAuthStore((state) => state.user);
  const [state, setState] = useState<RuntimeState>({
    authMode: null,
    landing: FALLBACK_LANDING,
    status: 'loading',
  });
  const attemptRef = useRef(0);
  const runtimeRequestRef = useRef<Promise<RuntimeCapabilities> | null>(null);
  const landingRef = useRef<LandingConfig>(FALLBACK_LANDING);

  const initialize = useCallback(async (knownMode: AuthMode | null) => {
    const attempt = ++attemptRef.current;
    const isCurrent = () => attemptRef.current === attempt;
    let authMode = knownMode;

    setState({ authMode, landing: landingRef.current, status: 'loading' });

    try {
      if (!authMode) {
        runtimeRequestRef.current ??= (async () => {
          const response = await fetch('/api/runtime');
          if (!response.ok) throw new Error('runtime capabilities unavailable');
          const runtime = await response.json() as { authMode?: unknown; landing?: unknown };
          if (runtime.authMode !== 'local' && runtime.authMode !== 'server') {
            throw new Error('invalid runtime capabilities');
          }
          return { authMode: runtime.authMode, landing: parseLanding(runtime.landing) };
        })();
        const capabilities = await runtimeRequestRef.current;
        authMode = capabilities.authMode;
        landingRef.current = capabilities.landing;
      }

      if (!isCurrent()) return;

      if (authMode === 'local') {
        const session = await fetch('/api/auth/local-session', {
          method: 'POST',
          credentials: 'include',
        });
        if (!session.ok) throw new Error('local session unavailable');
        const { accessToken } = await session.json() as { accessToken: string };
        if (!isCurrent()) return;
        setAccessToken(accessToken);
        const me = await api<MeResponse>('/auth/me');
        if (!isCurrent()) return;
        useAuthStore.getState().setSession({ ...me, isAdmin: me.isAdmin ?? false }, accessToken);
      }

      if (isCurrent()) setState({ authMode, landing: landingRef.current, status: 'ready' });
    } catch {
      if (!authMode) runtimeRequestRef.current = null;
      if (isCurrent()) setState({ authMode, landing: landingRef.current, status: 'error' });
    }
  }, []);

  useEffect(() => {
    void initialize(null);
    return () => { attemptRef.current += 1; };
  }, [initialize]);

  useEffect(() => {
    if (state.authMode === 'local' && state.status === 'ready' && !user) {
      void initialize('local');
    }
  }, [initialize, state.authMode, state.status, user]);

  if (state.status === 'error') {
    return (
      <main className="mx-auto flex min-h-screen max-w-lg flex-col justify-center px-6 py-12">
        <h1 className="text-2xl font-semibold text-ink">Weltbon could not open</h1>
        <p className="mt-3 text-sm text-ink-secondary">
          {/*
            This surface is also reachable before the mode is known — a failed
            `/api/runtime` leaves `authMode` null in server deployments too, so
            the local "application data folder" reassurance must not be the
            fallback copy.
          */}
          {state.authMode === 'local'
            ? 'Your data remains in Weltbon’s application data folder.'
            : 'Weltbon could not reach its server. Your data is unaffected.'}
        </p>
        <button
          className="mt-6 w-fit rounded btn-accent px-4 py-2 text-sm font-medium"
          type="button"
          onClick={() => { void initialize(state.authMode); }}
        >
          Retry
        </button>
      </main>
    );
  }

  if (state.status !== 'ready' || !state.authMode) return null;

  return (
    <RuntimeContext.Provider value={{ authMode: state.authMode, landing: state.landing }}>
      {children}
    </RuntimeContext.Provider>
  );
}
