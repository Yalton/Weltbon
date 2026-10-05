import type { CSSProperties } from 'react';
import { Link } from 'react-router-dom';
import { useRuntime } from '../runtime/RuntimeProvider';

/**
 * Public front door for server-mode instances. Signup is invite-only, so the
 * page explains what Weltbon is and offers two ways in: ask this instance's
 * operator for an invitation, or run your own copy.
 */
export function Landing() {
  const { landing } = useRuntime();

  return (
    <div className="landing min-h-full flex flex-col">
      <header className="mx-auto flex w-full max-w-5xl items-center justify-between px-4 pt-6 sm:px-8">
        <span className="wordmark text-2xl">Weltbon</span>
        <Link
          to="/login"
          className="rounded-md px-3 py-1.5 text-sm text-ink-secondary transition-colors hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--color-accent)]"
        >
          Sign in
        </Link>
      </header>

      <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col px-4 sm:px-8">
        <section className="relative grid items-center gap-10 py-14 sm:py-20 md:grid-cols-[minmax(0,1fr)_minmax(0,22rem)]">
          <div>
            <h1 className="font-display text-4xl font-medium leading-[1.1] tracking-[-0.015em] text-ink text-balance sm:text-5xl">
              Your world, written down and wired together.
            </h1>
            <p className="mt-6 max-w-[60ch] text-base leading-relaxed text-ink-secondary sm:text-lg">
              Weltbon is a self-hosted workspace for worldbuilding. Write entries for the people,
              places and events of your setting, link them to one another, and see how it all
              connects in a graph, a timeline and your own maps. Export your work whenever you like.
            </p>
          </div>
          <LoreGraph />
        </section>

        <section aria-labelledby="ways-in" className="pb-16">
          <h2 id="ways-in" className="sr-only">Ways to get started</h2>
          <div
            className={
              landing.inviteRequestsEnabled
                ? 'grid overflow-hidden rounded-[14px] border border-glass-border bg-glass md:grid-cols-2'
                : 'max-w-xl overflow-hidden rounded-[14px] border border-glass-border bg-glass'
            }
          >
            {landing.inviteRequestsEnabled && (
              <div className="flex flex-col p-7 sm:p-9">
                <h3 className="font-display text-2xl font-medium text-ink">Request an invitation</h3>
                <p className="mt-3 max-w-[46ch] text-sm leading-relaxed text-ink-secondary">
                  Accounts on this server are invite-only. Leave your name and email, and the person
                  who runs it can send you an invitation code.
                </p>
                <div className="mt-auto pt-7">
                  <Link
                    to="/request-invite"
                    className="btn-accent inline-flex items-center gap-2 rounded-lg px-5 py-2.5 text-sm font-semibold text-white [box-shadow:var(--shadow-glow-accent),inset_0_1px_0_rgb(255_255_255/0.25)] transition-[filter] hover:brightness-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ink focus-visible:ring-offset-2 focus-visible:ring-offset-canvas-mid"
                  >
                    Request an invitation
                    <ArrowIcon />
                  </Link>
                </div>
              </div>
            )}

            <div
              className={
                landing.inviteRequestsEnabled
                  ? 'flex flex-col border-t border-glass-border p-7 sm:p-9 md:border-l md:border-t-0'
                  : 'flex flex-col p-7 sm:p-9'
              }
            >
              <h3 className="font-display text-2xl font-medium text-ink">Run it on your own hardware</h3>
              <p className="mt-3 max-w-[46ch] text-sm leading-relaxed text-ink-secondary">
                Weltbon is open source. Run it with Docker on a home server or VPS, or use the desktop
                app, and keep your worlds on machines you control.
              </p>
              <div className="mt-auto pt-7">
                <a
                  href={landing.repoUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-2 rounded-lg border border-glass-border bg-white/5 px-5 py-2.5 text-sm font-medium text-ink transition-colors hover:border-accent-strong/40 hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--color-accent)]"
                >
                  Get the source
                  <ExternalIcon />
                  <span className="sr-only">(opens in a new tab)</span>
                </a>
              </div>
            </div>
          </div>

          <p className={`mt-6 text-sm text-ink-secondary ${landing.inviteRequestsEnabled ? 'text-center' : ''}`}>
            Already have an invitation code?{' '}
            <Link
              to="/register"
              className="text-accent-ink underline decoration-accent-strong/50 underline-offset-4 hover:decoration-accent-ink"
            >
              Create your account
            </Link>
          </p>
        </section>
      </main>
    </div>
  );
}

// Entry nodes and the links between them, the core idea of the app, drawn as a
// small constellation. Purely decorative.
const NODES: Array<[number, number, number]> = [
  [60, 70, 5], [170, 40, 4], [250, 110, 6], [120, 160, 4.5],
  [215, 215, 4], [300, 190, 3.5], [55, 245, 3.5], [150, 280, 5],
];
const EDGES: Array<[number, number]> = [
  [0, 1], [1, 2], [0, 3], [3, 2], [2, 5], [3, 4], [4, 5], [3, 6], [6, 7], [4, 7],
];

function LoreGraph() {
  return (
    <svg
      viewBox="0 0 340 320"
      aria-hidden="true"
      className="lore-graph mx-auto hidden w-full max-w-[22rem] md:block"
    >
      <g stroke="var(--color-accent-strong)" strokeWidth="1" strokeLinecap="round" fill="none">
        {EDGES.map(([a, b], i) => {
          const [x1, y1] = NODES[a];
          const [x2, y2] = NODES[b];
          const length = Math.hypot(x2 - x1, y2 - y1);
          return (
            <line
              key={`${a}-${b}`}
              x1={x1} y1={y1} x2={x2} y2={y2}
              style={{ '--link-length': length, animationDelay: `${i * 70}ms` } as CSSProperties}
            />
          );
        })}
      </g>
      {NODES.map(([x, y, r], i) => (
        <g key={i}>
          <circle cx={x} cy={y} r={r * 2.6} fill="var(--color-accent-soft)" />
          <circle cx={x} cy={y} r={r} fill="var(--color-accent-ink)" />
        </g>
      ))}
    </svg>
  );
}

function ArrowIcon() {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 8h10M9 4l4 4-4 4" />
    </svg>
  );
}

function ExternalIcon() {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M6 3H3.5A.5.5 0 0 0 3 3.5v9a.5.5 0 0 0 .5.5h9a.5.5 0 0 0 .5-.5V10M9 3h4v4M13 3 7.5 8.5" />
    </svg>
  );
}
