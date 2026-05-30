import { createContext, useContext, type ReactNode } from 'react';

/**
 * Phase 29 share-mode boolean context.
 *
 * Default value is `false` so any view rendered OUTSIDE a
 * `<ShareModeProvider>` continues to behave as today — there is ZERO visual
 * delta in the authenticated route tree. This is the T-29-27 leak-prevention
 * invariant at the context layer: forgetting to wrap in the provider results
 * in the safe (authenticated) behavior, never the share-mode behavior.
 *
 * The provider sets a fixed `value={true}` so descendants never need to
 * prop-drill the boolean. Views call `useShareMode()` and gate mutation
 * affordances per the UI-SPEC §A Kept-affordances table.
 */
export const ShareModeContext = createContext<boolean>(false);

/**
 * Wraps the `/share/:token` subtree so descendant views read `true` from
 * `useShareMode()`. Mounted exclusively by `ShareLayout`.
 */
export function ShareModeProvider({ children }: { children: ReactNode }) {
  return (
    <ShareModeContext.Provider value={true}>
      {children}
    </ShareModeContext.Provider>
  );
}

/**
 * Hook for views to discover whether they are rendering inside a share
 * subtree. Returns `false` outside any provider (the safe default).
 */
export function useShareMode(): boolean {
  return useContext(ShareModeContext);
}
