
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
