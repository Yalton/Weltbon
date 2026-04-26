import { useParams, Link } from 'react-router-dom';
import { useTimelinePins } from '../hooks/useTimelinePins';
import { groupByEra } from '../lib/groupByEra';
import { EmptyState } from '../components/EmptyState';
import { TypeBadge } from '../components/TypeBadge';

/**
 * Tailwind class for the small precision dot on each pin row in /timeline.
 * Mirrors the choices in TimelinePinSection's PrecisionBadge:
 *   era → accent (violet), approximate → neutral-400, exact → neutral-200.
 */
function precisionDotClass(p: 'exact' | 'approximate' | 'era'): string {
  const base = 'inline-block w-2 h-2 shrink-0 rounded-full';
  switch (p) {
    case 'era':
      return `${base} bg-[color:var(--color-accent)]`;
    case 'approximate':
      return `${base} bg-neutral-400`;
    case 'exact':
    default:
      return `${base} bg-neutral-200 dark:bg-neutral-300`;
  }
}

/**
 * /universes/:uid/timeline — sorted, era-grouped pin list.
 *
 * The API returns pins sorted ASC by position; groupByEra preserves that
 * order, emitting era pins as group headers and rolling subsequent non-era
 * pins under the most recent era. Era heading is sticky so it stays visible
 * while scrolling through long lists.
 *
 * Each pin row is a Link to /universes/:uid/entries/:entryId so users can
 * jump straight from the timeline into the entry detail (matches Phase 3
 * GRAPH-04 click-to-navigate pattern).
 */
export function TimelineView() {
  const { uid } = useParams<{ uid: string }>();
  const { data: pins, isLoading } = useTimelinePins(uid!);

  if (isLoading) {
    return <p className="text-sm text-neutral-500">Loading…</p>;
  }
  if (!pins || pins.length === 0) {
    return (
      <EmptyState
        title="No pins yet"
        body="Open an entry and add one from its Timeline section."
      />
    );
  }

  const groups = groupByEra(pins);

  return (
    <div className="max-w-3xl mx-auto">
      <h1 className="text-2xl font-semibold mb-6">Timeline</h1>
      <div className="space-y-2">
        {groups.map((g, i) => (
          <section key={g.era?.id ?? `null-${i}`} className="space-y-1">
            {g.era && (
              <h2 className="sticky top-0 bg-white dark:bg-neutral-950 py-1 text-sm uppercase tracking-wide text-[color:var(--color-accent)]">
                {g.era.label}
                <span className="ml-2 text-neutral-500 normal-case tabular-nums">
                  {g.era.position}
                </span>
              </h2>
            )}
            <ul className="space-y-1">
              {g.pins.map((p) => (
                <li key={p.id}>
                  <Link
                    to={`/universes/${uid}/entries/${p.entryId}`}
                    className="flex items-center gap-3 px-3 py-2 rounded-md hover:bg-neutral-100 dark:hover:bg-neutral-900"
                  >
                    <span aria-hidden className={precisionDotClass(p.precision)} />
                    <span className="font-medium">{p.label}</span>
                    {p.entryTitle && (
                      <span className="text-neutral-500 truncate">— {p.entryTitle}</span>
                    )}
                    {p.entryType && <TypeBadge type={p.entryType} />}
                    <span className="ml-auto text-sm text-neutral-500 tabular-nums">
                      {p.position}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </div>
  );
}
