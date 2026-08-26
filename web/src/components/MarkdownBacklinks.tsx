import { Link } from 'react-router-dom';
import type { AssetSummary } from '../hooks/useAssets';
import type { Backlink, Entry } from '../hooks/useEntries';
import { splitUnsupportedBlocks } from './MarkdownAuthoringEditor';

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
  /** Retained for the renderer's signed-URL data; existence comes from assets. */
  savedAssetUrls?: Record<string, string>;
  /** The existing asset query is the authority for whether an asset still exists. */
  assets?: AssetSummary[];
  entries: Entry[];
  onRevealSelection: (selection: MarkdownRecoverySelection) => void;
  onReplaceAsset: (selection: MarkdownAssetRecoverySelection) => void;
};

type MarkdownRange = { start: number; end: number };

function normalizedLine(rawLine: string): string {
  return rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
}

function fencedCodeRanges(markdown: string): MarkdownRange[] {
  const lines = markdown.split('\n');
  const ranges: MarkdownRange[] = [];
  let cursor = 0;
  let fence: { marker: string; length: number } | null = null;
  let fenceStart: number | null = null;

  lines.forEach((rawLine) => {
    const line = normalizedLine(rawLine);
    if (fence) {
      if (new RegExp(`^ {0,3}${fence.marker}{${fence.length},}[ \\t]*$`).test(line)) {
        ranges.push({ start: fenceStart ?? cursor, end: cursor + rawLine.length });
        fence = null;
        fenceStart = null;
      }
    } else {
      const opening = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
      if (opening && !(opening[1][0] === '`' && opening[2].includes('`'))) {
        fence = { marker: opening[1][0], length: opening[1].length };
        fenceStart = cursor;
      }
    }
    cursor += rawLine.length + 1;
  });

  if (fenceStart !== null) ranges.push({ start: fenceStart, end: markdown.length });
  return ranges;
}

function indentedCodeRanges(markdown: string): MarkdownRange[] {
  const lines = markdown.split('\n');
  const ranges: MarkdownRange[] = [];
  let cursor = 0;
  let start: number | null = null;

  lines.forEach((rawLine) => {
    const line = normalizedLine(rawLine);
    const isIndentedCode = /^(?: {4,}|\t)/.test(line);
    if (isIndentedCode && start === null) start = cursor;
    if (!isIndentedCode && start !== null) {
      ranges.push({ start, end: cursor });
      start = null;
    }
    cursor += rawLine.length + 1;
  });

  if (start !== null) ranges.push({ start, end: markdown.length });
  return ranges;
}

function inlineCodeRanges(markdown: string): MarkdownRange[] {
  const ranges: MarkdownRange[] = [];
  let index = 0;
  while (index < markdown.length) {
    if (markdown[index] !== '`' || (index > 0 && markdown[index - 1] === '\\')) {
      index += 1;
      continue;
    }
    let runLength = 1;
    while (markdown[index + runLength] === '`') runLength += 1;
    const run = '`'.repeat(runLength);
    let close = markdown.indexOf(run, index + runLength);
    while (close !== -1 && (markdown[close - 1] === '`' || markdown[close + runLength] === '`')) {
      close = markdown.indexOf(run, close + 1);
    }
    if (close === -1) {
      index += runLength;
      continue;
    }
    ranges.push({ start: index, end: close + runLength });
    index = close + runLength;
  }
  return ranges;
}

function supportedRangesForPart(markdown: string, offset: number): MarkdownRange[] {
  const excluded = [
    ...fencedCodeRanges(markdown),
    ...indentedCodeRanges(markdown),
    ...inlineCodeRanges(markdown),
  ].sort((left, right) => left.start - right.start || left.end - right.end);
  const ranges: MarkdownRange[] = [];
  let cursor = 0;
  excluded.forEach((range) => {
    if (range.start > cursor) ranges.push({ start: offset + cursor, end: offset + range.start });
    cursor = Math.max(cursor, range.end);
  });
  if (cursor < markdown.length) ranges.push({ start: offset + cursor, end: offset + markdown.length });
  return ranges;
}

function supportedMarkdownRanges(markdown: string): MarkdownRange[] {
  const ranges: MarkdownRange[] = [];
  let offset = 0;
  splitUnsupportedBlocks(markdown).forEach((part) => {
    if (part.kind === 'markdown') ranges.push(...supportedRangesForPart(part.content, offset));
    offset += part.content.length;
  });
  return ranges;
}

function supportedMatches(markdown: string, pattern: RegExp): Array<{ match: RegExpExecArray; index: number }> {
  const matches: Array<{ match: RegExpExecArray; index: number }> = [];
  supportedMarkdownRanges(markdown).forEach(({ start, end }) => {
    const source = markdown.slice(start, end);
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(source)) !== null) {
      matches.push({ match, index: start + match.index });
    }
  });
  return matches;
}

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

  supportedMatches(markdown, pattern).forEach(({ match, index }) => {
    const target = normalizedWikilinkTarget(match[1]);
    if (target.length === 0 || !knownTargets.has(target)) {
      matches.push({
        start: index,
        end: index + match[0].length,
        raw: match[0],
      });
    }
  });

  return matches;
}

type AssetReference = MarkdownAssetRecoverySelection & { assetId: string };

function assetReferences(markdown: string): AssetReference[] {
  const references: AssetReference[] = [];
  const pattern = /!\[([^\]]*)\]\(asset:\/\/([^)]+)\)/g;
  supportedMatches(markdown, pattern).forEach(({ match, index }) => {
    references.push({
      assetId: match[2],
      altText: match[1] || 'image',
      start: index,
      end: index + match[0].length,
      raw: match[0],
    });
  });
  return references;
}

function missingSavedAssets(
  draftMarkdown: string,
  savedMarkdown: string,
  savedAssetUrls: Record<string, string>,
  assets: AssetSummary[] | undefined,
): MarkdownAssetRecoverySelection[] {
  // Until the existing asset query resolves, there is no authoritative answer.
  if (!assets) return [];
  void savedAssetUrls;
  const existingAssetIds = new Set(assets.map((asset) => asset.id));
  const missingSavedIds = new Set(
    assetReferences(savedMarkdown)
      .filter((reference) => !existingAssetIds.has(reference.assetId))
      .map((reference) => reference.assetId),
  );
  return assetReferences(draftMarkdown)
    .filter((reference) => missingSavedIds.has(reference.assetId))
    .map(({ assetId: _assetId, ...selection }) => selection);
}

export function MarkdownBacklinks({
  universeId,
  backlinks,
  draftMarkdown,
  savedMarkdown,
  savedAssetUrls = {},
  assets,
  entries,
  onRevealSelection,
  onReplaceAsset,
}: MarkdownBacklinksProps) {
  const rawReferences = unresolvedDraftReferences(draftMarkdown, entries);
  const assetRecoveries = missingSavedAssets(draftMarkdown, savedMarkdown, savedAssetUrls, assets);

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
