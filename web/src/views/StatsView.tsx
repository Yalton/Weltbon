import { useParams, useNavigate } from 'react-router-dom';
import { useStats } from '../hooks/useStats';

function relativeTime(isoString: string): string {
  const then = new Date(isoString).getTime();
  const now = Date.now();
  const diffMs = now - then;
  const diffSec = Math.floor(diffMs / 1000);
  const diffMin = Math.floor(diffSec / 60);
  const diffHour = Math.floor(diffMin / 60);
  const diffDay = Math.floor(diffHour / 24);
  const diffMonth = Math.floor(diffDay / 30);
  const diffYear = Math.floor(diffDay / 365);

  if (diffSec < 60) return 'just now';
  if (diffMin < 60) return `${diffMin} minute${diffMin === 1 ? '' : 's'} ago`;
  if (diffHour < 24) return `${diffHour} hour${diffHour === 1 ? '' : 's'} ago`;
  if (diffDay < 30) return `${diffDay} day${diffDay === 1 ? '' : 's'} ago`;
  if (diffMonth < 12) return `${diffMonth} month${diffMonth === 1 ? '' : 's'} ago`;
  return `${diffYear} year${diffYear === 1 ? '' : 's'} ago`;
}

export function StatsView() {
  const { uid } = useParams<{ uid: string }>();
  const navigate = useNavigate();
  const { data, isLoading, isError } = useStats(uid);

  const totalEntries = data?.totalEntries ?? 0;

  if (isError) {
    return (
      <div className="max-w-4xl mx-auto">
        <h1 className="text-xl font-semibold mb-6">Universe overview</h1>
        <p className="text-sm text-red-500 py-4">Couldn't load stats. Refresh to try again.</p>
      </div>
    );
  }

  return (
    <div className="max-w-4xl mx-auto">
      <h1 className="text-xl font-semibold mb-6">Universe overview</h1>

      {/* Stat cards */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        {[
          { label: 'Entries', count: data?.totalEntries },
          { label: 'Links', count: data?.totalLinks },
          { label: 'Pinned events', count: data?.totalTimelinePins },
          { label: 'Categories', count: data?.totalCategories },
        ].map(({ label, count }) => (
          <article
            key={label}
            aria-label={`${count ?? 'Loading...'} ${label}`}
            className="rounded-md border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 p-4 flex flex-col gap-1"
          >
            {isLoading ? (
              <span className="text-sm text-ink-muted">Loading...</span>
            ) : (
              <span className="text-xl font-semibold tabular-nums text-neutral-900 dark:text-neutral-100">
                {count}
              </span>
            )}
            <span className="text-xs text-neutral-500 uppercase tracking-wide">{label}</span>
          </article>
        ))}
      </div>

      {/* Distribution bars — By type */}
      <h2 className="text-sm font-semibold mt-8 mb-3">By type</h2>
      {isLoading ? (
        <div className="space-y-2">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-4 rounded bg-neutral-200 dark:bg-neutral-800 animate-pulse motion-reduce:animate-none" />
          ))}
        </div>
      ) : (
        <div className="space-y-0.5">
          {(data?.entriesByType ?? []).map(({ type, count }) => {
            const pct = totalEntries > 0 ? (count / totalEntries) * 100 : 0;
            return (
              <button
                key={type}
                type="button"
                role="button"
                tabIndex={0}
                onClick={() => navigate(`/universes/${uid}/entries?type=${encodeURIComponent(type)}`)}
                aria-label={`${type}: ${count} entries`}
                className="w-full flex items-center gap-3 py-1 px-2 rounded hover:bg-neutral-100 dark:hover:bg-neutral-800 cursor-pointer text-left"
              >
                <span className="text-sm truncate w-32 flex-shrink-0 text-neutral-700 dark:text-neutral-300">
                  {type}
                </span>
                <div className="flex-1 h-2 rounded-full bg-neutral-200 dark:bg-neutral-800 overflow-hidden">
                  <div
                    className="h-full rounded-full bg-[color:var(--color-accent)]"
                    style={{ width: `${pct}%` }}
                  />
                </div>
                <span className="text-xs tabular-nums text-neutral-500 w-8 text-right">{count}</span>
              </button>
            );
          })}
        </div>
      )}

      {/* Distribution bars — By category */}
      <h2 className="text-sm font-semibold mt-8 mb-3">By category</h2>
      {isLoading ? (
        <div className="space-y-2">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-4 rounded bg-neutral-200 dark:bg-neutral-800 animate-pulse motion-reduce:animate-none" />
          ))}
        </div>
      ) : (
        <div className="space-y-0.5">
          {(data?.categoryDistribution ?? []).map(({ categoryId, label, count }) => {
            const pct = totalEntries > 0 ? (count / totalEntries) * 100 : 0;
            return (
              <button
                key={categoryId ?? '__uncategorized__'}
                type="button"
                role="button"
                tabIndex={0}
                onClick={() =>
                  navigate(
                    `/universes/${uid}/entries${categoryId ? `?category=${encodeURIComponent(categoryId)}` : ''}`,
                  )
                }
                aria-label={`${label}: ${count} entries`}
                className="w-full flex items-center gap-3 py-1 px-2 rounded hover:bg-neutral-100 dark:hover:bg-neutral-800 cursor-pointer text-left"
              >
                <span className="text-sm truncate w-32 flex-shrink-0 text-neutral-700 dark:text-neutral-300">
                  {label}
                </span>
                <div className="flex-1 h-2 rounded-full bg-neutral-200 dark:bg-neutral-800 overflow-hidden">
                  <div
                    className="h-full rounded-full bg-[color:var(--color-accent)]"
                    style={{ width: `${pct}%` }}
                  />
                </div>
                <span className="text-xs tabular-nums text-neutral-500 w-8 text-right">{count}</span>
              </button>
            );
          })}
        </div>
      )}

      {/* Recently edited */}
      <h2 className="text-sm font-semibold mt-8 mb-3">Recently edited</h2>
      {isLoading ? (
        <div className="space-y-2">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-4 rounded bg-neutral-200 dark:bg-neutral-800 animate-pulse motion-reduce:animate-none" />
          ))}
        </div>
      ) : (
        <>
          {data && data.recentlyEdited.length === 0 ? (
            <p className="text-sm text-neutral-500 py-4">No entries yet.</p>
          ) : (
            <ul aria-label="Recently edited entries" className="space-y-1">
              {(data?.recentlyEdited ?? []).slice(0, 10).map((entry) => (
                <li key={entry.id}>
                  <button
                    type="button"
                    aria-label={`${entry.title} — edited ${relativeTime(entry.updatedAt)}`}
                    onClick={() => navigate(`/universes/${uid}/entries/${entry.id}`)}
                    className="w-full flex items-center gap-3 py-1.5 px-2 rounded hover:bg-neutral-100 dark:hover:bg-neutral-800 cursor-pointer text-left"
                  >
                    <span className="text-base">{entry.icon || '○'}</span>
                    <span className="text-sm truncate flex-1">{entry.title}</span>
                    <span className="text-xs text-neutral-500 flex-shrink-0">
                      {relativeTime(entry.updatedAt)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}
