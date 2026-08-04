/**
 * Plan F — the one way the sync UI renders a `SyncCopy`.
 *
 * Shared by /settings/sync (Task 2) and the universe Sync tab (Task 3) rather
 * than copied, because the two callers feed it copy from DIFFERENT producers
 * whose field shapes disagree, and the disagreement is easy to miss:
 *
 *   - `syncErrorMessage(err)` — `detail` and `raw` are disjoint. `raw` is the
 *     throw site's own message; nothing in it repeats `detail`.
 *   - `lastErrorMessage(link.lastError)` — `raw` is the WHOLE `last_error`
 *     column, with `detail` already embedded verbatim inside it (see
 *     lib/syncErrorCopy.ts's docstring on `SyncCopy.raw`).
 *
 * A component that unconditionally renders message + detail + <details>{raw}
 * is correct for the first producer and prints the detail twice for the
 * second. So the disclosure is suppressed when `raw` already contains
 * `detail`: there is no information in it the user has not been shown.
 */

import type { SyncCopy } from '../lib/syncErrorCopy';

export function SyncErrorNotice({
  copy,
  testId,
  className = '',
}: {
  copy: SyncCopy;
  testId?: string;
  className?: string;
}) {
  // `includes` rather than equality: on the `lastErrorMessage` path `raw` is
  // `${code}: ${detail}`, so it CONTAINS the detail without being equal to it.
  const rawAddsSomething = !!copy.raw && !(copy.detail && copy.raw.includes(copy.detail));

  return (
    <div
      role="alert"
      data-testid={testId}
      className={`mt-3 rounded-lg border border-rose-500/30 bg-rose-500/10 p-3 text-sm text-rose-300 ${className}`}
    >
      <p>{copy.message}</p>
      {copy.detail && <p className="mt-1 text-xs opacity-90">{copy.detail}</p>}
      {rawAddsSomething && (
        <details className="mt-1">
          <summary className="cursor-pointer text-xs opacity-80">Show details</summary>
          <pre className="mt-1 whitespace-pre-wrap break-words text-xs opacity-80">{copy.raw}</pre>
        </details>
      )}
    </div>
  );
}
