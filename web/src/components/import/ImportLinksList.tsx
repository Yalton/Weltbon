import type { LinkOut } from '../../types/ingestReview';

interface ImportLinksListProps {
  linksOut: LinkOut[];
}

export function ImportLinksList({ linksOut }: ImportLinksListProps) {
  return (
    <div className="mt-6 pt-6 border-t border-neutral-200 dark:border-neutral-800">
      <h2 className="text-xl font-semibold mb-2">Links</h2>
      {linksOut.length === 0 ? (
        <p className="text-sm text-neutral-500">No outbound links.</p>
      ) : (
        <ul className="space-y-1 text-sm">
          {linksOut.map((link, i) => (
            <li
              key={`${link.target}-${i}`}
              className="flex items-center justify-between gap-2"
            >
              <span className="font-mono text-neutral-700 dark:text-neutral-200">
                [[{link.target}]]
              </span>
              {link.resolved ? (
                <span
                  role="status"
                  className="inline-flex items-center text-xs font-medium rounded-full bg-emerald-100 dark:bg-emerald-900/40 text-emerald-700 dark:text-emerald-300 px-2 py-0.5"
                >
                  <span className="sr-only">Status: </span>
                  Resolved
                </span>
              ) : (
                <span
                  role="status"
                  className="inline-flex items-center text-xs font-medium rounded-full bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-300 px-2 py-0.5"
                >
                  <span className="sr-only">
                    Status: Unresolved — target &quot;{link.target}&quot; not found in batch or universe.
                  </span>
                  Unresolved
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
