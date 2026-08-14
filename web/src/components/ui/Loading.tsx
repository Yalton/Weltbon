import { cx } from './cx';

/**
 * The app's single loading state (#32).
 *
 * Replaces ten hand-rolled `<p>Loading...</p>` copies that had already drifted
 * apart (`text-neutral-500` in most, `text-ink-muted` in one). The neutral
 * variants were the visible defect: against `--color-canvas-lo` (#070912) they
 * are barely legible, and pinned to the top-left of an otherwise empty viewport
 * they read as a broken page rather than a loading one.
 *
 * Accessibility notes, both deliberate:
 *  - `role="status"` carries an implicit `aria-live="polite"`, so the state is
 *    announced when it appears without stealing focus.
 *  - The label is real text kept in the accessibility tree via `sr-only` rather
 *    than an `aria-label` on a decorative element. The old bare string at least
 *    announced itself; a spinner that only spins would have been a regression
 *    for anyone not looking at it.
 *
 * Reduced motion needs no handling here: styles.css already forces
 * `animation-iteration-count: 1` and a ~0ms duration under
 * `prefers-reduced-motion: reduce`, which parks the ring as a static shape. The
 * ring is drawn as a full circle with one accent-colored quadrant so that
 * parked state still looks intentional rather than half-rendered.
 */
export function Loading({
  label = 'Loading…',
  fullPage = false,
  className = '',
}: {
  label?: string;
  /** Center in the viewport — for route-level waits, where nothing else is on screen. */
  fullPage?: boolean;
  className?: string;
}) {
  return (
    <div
      role="status"
      className={cx(
        'flex flex-col items-center justify-center gap-3 text-ink-muted',
        fullPage ? 'min-h-[60vh] w-full' : 'min-h-[8rem] w-full py-8',
        className,
      )}
    >
      <span
        aria-hidden="true"
        className="animate-spinner h-8 w-8 rounded-full border-2 border-glass-border border-t-[color:var(--color-accent-strong)]"
      />
      <span className="sr-only">{label}</span>
    </div>
  );
}
