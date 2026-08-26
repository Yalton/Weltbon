import { Link } from 'react-router-dom';
import type { Backlink, Entry } from '../hooks/useEntries';

export type MarkdownRecoverySelection = {
  start: number;
  end: number;
  raw: string;
};

export type MarkdownAssetRecoverySelection = MarkdownRecoverySelection & {
  altText: string;
};

type MarkdownBacklinksProps = {
  universeId: string;
  backlinks: Backlink[];
  draftMarkdown: string;
  savedMarkdown: string;
  savedAssetUrls?: Record<string, string>;
  entries: Entry[];
  onRevealSelection: (selection: MarkdownRecoverySelection) => void;
  onReplaceAsset: (selection: MarkdownAssetRecoverySelection) => void;
};

function normalizedWikilinkTarget(raw: string): string {
  const pipeIndex = raw.indexOf('|');
  const hashIndex = raw.indexOf('#');
  const endIndex = [pipeIndex, hashIndex].filter((index) => index >= 0).sort((left, right) => left - right)[0] ?? raw.length;
  return raw.slice(0, endIndex).replace(/\.md$/i, '').trim().toLowerCase();
}

function unresolvedDraftReferences(markdown: string, entries: Entry[]): MarkdownRecoverySelection[] {
  const knownTargets = new Set(
    entries.flatMap((entry) => [entry.title, ...(entry.aliases ?? [])]).map((value) => value.trim().toLowerCase()),
  );
  const matches: MarkdownRecoverySelection[] = [];
  const pattern = /\[\[([^\]\n]+?)\]\]/g;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(markdown)) !== null) {
    const target = normalizedWikilinkTarget(match[1]);
    if (target.length === 0 || !knownTargets.has(target)) {
      matches.push({
        start: match.index,
        end: match.index + match[0].length,
        raw: match[0],
      });
    }
  }

  return matches;
}

function missingSavedAssets(
  draftMarkdown: string,
  savedMarkdown: string,
  savedAssetUrls: Record<string, string>,
): MarkdownAssetRecoverySelection[] {
  const missingSavedIds = new Set<string>();
  const savedPattern = /!\[([^\]]*)\]\(asset:\/\/([^)]+)\)/g;
  let savedMatch: RegExpExecArray | null;
  while ((savedMatch = savedPattern.exec(savedMarkdown)) !== null) {
    if (!savedAssetUrls[savedMatch[2]]) missingSavedIds.add(savedMatch[2]);
  }

  const draftMatches: MarkdownAssetRecoverySelection[] = [];
  const draftPattern = /!\[([^\]]*)\]\(asset:\/\/([^)]+)\)/g;
  let draftMatch: RegExpExecArray | null;
  while ((draftMatch = draftPattern.exec(draftMarkdown)) !== null) {
    if (!missingSavedIds.has(draftMatch[2])) continue;
    draftMatches.push({
      altText: draftMatch[1] || 'image',
      start: draftMatch.index,
      end: draftMatch.index + draftMatch[0].length,
      raw: draftMatch[0],
    });
  }

  return draftMatches;
}

export function MarkdownBacklinks({
  universeId,
  backlinks,
  draftMarkdown,
  savedMarkdown,
  savedAssetUrls = {},
  entries,
  onRevealSelection,
  onReplaceAsset,
}: MarkdownBacklinksProps) {
  const rawReferences = unresolvedDraftReferences(draftMarkdown, entries);
  const assetRecoveries = missingSavedAssets(draftMarkdown, savedMarkdown, savedAssetUrls);

  return (
    <section aria-label="Markdown backlinks and recovery">
      <h2 className="text-sm font-semibold text-neutral-900 dark:text-neutral-100">Backlinks</h2>
      {backlinks.length === 0 ? (
        <p className="mt-2 text-sm text-neutral-500 dark:text-neutral-400">
          Backlinks appear after you save.
        </p>
      ) : (
        <ul className="mt-2 space-y-2">
          {backlinks.map((backlink) => (
            <li key={backlink.id} className="flex items-center gap-2">
              <Link
                to={`/universes/${universeId}/entries/${backlink.sourceEntryId}`}
                className="text-sm text-[color:var(--color-accent)] hover:underline"
              >
                {backlink.sourceTitle}
              </Link>
              {backlink.label && (
                <span className="text-xs text-neutral-400 dark:text-neutral-500">{backlink.label}</span>
              )}
            </li>
          ))}
        </ul>
      )}

      <div className="mt-4 border-t border-neutral-200 pt-4 dark:border-neutral-800">
        <h3 className="text-sm font-semibold text-neutral-900 dark:text-neutral-100">Recovery</h3>
        {rawReferences.length === 0 && assetRecoveries.length === 0 ? (
          <p className="mt-2 text-sm text-neutral-500 dark:text-neutral-400">
            No raw references or missing images need recovery.
          </p>
        ) : (
          <ul className="mt-2 space-y-3">
            {rawReferences.map((reference) => (
              <li key={`${reference.start}-${reference.raw}`} className="space-y-1">
                <code className="block rounded bg-neutral-100 px-2 py-1 text-xs text-neutral-700 dark:bg-neutral-900 dark:text-neutral-200">
                  {reference.raw}
                </code>
                <button
                  type="button"
                  onClick={() => onRevealSelection(reference)}
                  className="text-sm text-[color:var(--color-accent)] hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--color-accent)]"
                >
                  Open in source
                </button>
              </li>
            ))}
            {assetRecoveries.map((asset) => (
              <li key={`${asset.start}-${asset.raw}`} className="space-y-1">
                <code className="block rounded bg-neutral-100 px-2 py-1 text-xs text-neutral-700 dark:bg-neutral-900 dark:text-neutral-200">
                  {asset.raw}
                </code>
                <button
                  type="button"
                  onClick={() => onReplaceAsset(asset)}
                  className="text-sm text-[color:var(--color-accent)] hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--color-accent)]"
                >
                  Replace image
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
