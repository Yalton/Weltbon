export function ShareNotFound() {
  return (
    <div className="min-h-full flex flex-col">
      <header className="border-b border-line px-6 py-3">
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
          <p className="text-sm text-ink-secondary">
            This share link may have expired or been revoked. Ask the owner
            for an updated link.
          </p>
        </div>
      </main>
    </div>
  );
}
