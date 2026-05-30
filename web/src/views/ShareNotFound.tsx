/**
 * UI-SPEC §G — invalid / revoked / expired token page.
 *
 * Rendered by `ShareLayout` when `GET /api/share/universe` returns 404 (or
 * any other error — the visitor has no useful recovery action either way,
 * so we collapse all error states to the same surface). Per D-19 there is
 * NO login or register CTA — the visitor's intent is to view shared
 * content, not to be acquired; the error page is not the right moment.
 *
 * Layout deliberately avoids `ShareLayout` (no banner, no sidebar) because
 * there is no universe name or owner display name to render in the banner.
 * The Weltbon wordmark at top-left mirrors the authenticated `Layout`
 * header for visual continuity with the rest of the app.
 */
export function ShareNotFound() {
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
          <h1 className="text-2xl font-semibold mb-2">Link not found</h1>
          <p className="text-sm text-neutral-600 dark:text-neutral-400">
            This share link may have expired or been revoked. Ask the owner
            for an updated link.
          </p>
        </div>
      </main>
    </div>
  );
}
