import { Link } from 'react-router-dom';
import { fromMarkdown } from 'mdast-util-from-markdown';
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
  savedAssetUrls?: Record<string, string>;
  assets?: AssetSummary[];
  entries: Entry[];
  onRevealSelection: (selection: MarkdownRecoverySelection) => void;
  onReplaceAsset: (selection: MarkdownAssetRecoverySelection) => void;
};

type MarkdownRange = { start: number; end: number };

function markdownCodeRanges(markdown: string): MarkdownRange[] {
  const ranges: MarkdownRange[] = [];
  try {
    const visit = (node: unknown): void => {
      if (typeof node !== 'object' || node === null) return;
      const candidate = node as { type?: unknown; position?: unknown; children?: unknown };
      if (candidate.type === 'code') {
        const position = candidate.position as {
          start?: { offset?: unknown };
          end?: { offset?: unknown };
        } | undefined;
        const start = position?.start?.offset;
        const end = position?.end?.offset;
        if (
          typeof start !== 'number'
          || !Number.isInteger(start)
          || start < 0
          || start > markdown.length
          || typeof end !== 'number'
          || !Number.isInteger(end)
          || end < start
          || end > markdown.length
        ) {
          throw new Error('Invalid code source position');
        }
        ranges.push({ start, end });
      }
      if (Array.isArray(candidate.children)) candidate.children.forEach(visit);
    };
    visit(fromMarkdown(markdown));
    return ranges;
  } catch {
    return [{ start: 0, end: markdown.length }];
  }
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
    ...markdownCodeRanges(markdown),
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
      <h2 className="text-sm font-semibold text-ink">Backlinks</h2>
      {backlinks.length === 0 ? (
        <p className="mt-2 text-sm text-ink-secondary">
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
                <span className="text-xs text-ink-muted">{backlink.label}</span>
              )}
            </li>
          ))}
        </ul>
      )}

      <div className="mt-4 border-t pt-4 border-line">
        <h3 className="text-sm font-semibold text-ink">Recovery</h3>
        {rawReferences.length === 0 && assetRecoveries.length === 0 ? (
          <p className="mt-2 text-sm text-ink-secondary">
            No raw references or missing images need recovery.
          </p>
        ) : (
          <ul className="mt-2 space-y-3">
            {rawReferences.map((reference) => (
              <li key={`${reference.start}-${reference.raw}`} className="space-y-1">
                <code className="block rounded px-2 py-1 text-xs bg-panel text-ink">
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
                <code className="block rounded px-2 py-1 text-xs bg-panel text-ink">
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
