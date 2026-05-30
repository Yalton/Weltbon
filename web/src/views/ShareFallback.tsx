/**
 * Visitor-facing render-error fallback for the /share/:token subtree.
 *
 * Rendered by `<ErrorBoundary fallback={<ShareFallback />}>` in App.tsx when
 * any component inside the share subtree throws during render. Mirrors
 * ShareNotFound's Tailwind-utility structure exactly (no `.share-not-found`
 * CSS class — ShareNotFound and this view both use plain Tailwind utilities).
 *
 * Copy is the §Error States "Token lookup fails" string from 29-UI-SPEC.md:
 * "Something went wrong loading this universe. Try refreshing the page."
 * The spec deliberately uses "this universe" in the error string — this is
 * distinct from the Gap-3 empty-state surface where "universe" jargon was
 * inappropriate. In an error context the copy is acceptable because the user
 * has already navigated to a share link with a universe in mind.
 *
 * Phase 29 Gap 2 (MEDIUM) — see 29-08-PLAN.md Task 2.
 */
export function ShareFallback() {
  return (
    <div className="min-h-full flex flex-col">
      <header className="border-b border-neutral-200 dark:border-neutral-800 px-6 py-3">
        <a
          href="/"
          className="font-semibold text-[color:var(--color-accent)]"
        >
          Weltbon
        </a>
      </header>
      <main className="flex-1 flex items-center justify-center">
        <div className="text-center max-w-md px-6">
          <h1 className="text-2xl font-semibold mb-2">Something went wrong</h1>
          <p className="text-sm text-neutral-600 dark:text-neutral-400">
            Something went wrong loading this universe. Try refreshing the page.
          </p>
        </div>
      </main>
    </div>
  );
}
