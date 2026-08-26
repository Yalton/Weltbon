import { useContext, useEffect, useMemo, useRef, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { QueryClientContext } from '@tanstack/react-query';
import { useEntries, type Entry } from '../hooks/useEntries';
import { buildInsertString, rankEntries } from './WikilinkAutocomplete';
import { AssetPickerModal } from './AssetPickerModal';
import type { AssetSummary } from '../hooks/useAssets';

export type MarkdownLinkKind = 'wikilink' | 'embed' | 'external' | 'image';

export type MarkdownLinkValue = {
  kind: MarkdownLinkKind;
  target: string;
  label: string;
};

export type MarkdownLinkDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onInsert: (markdown: string) => void;
  universeId: string;
  currentEntryId?: string | null;
  initialKind?: MarkdownLinkKind;
  initialTarget?: string;
  initialLabel?: string;
  /** Supplying entries is useful for callers that already have the list cached. */
  entries?: Entry[];
};

export function buildMarkdownLink({ kind, target, label }: MarkdownLinkValue): string {
  const cleanTarget = target.trim();
  switch (kind) {
    case 'wikilink':
      return label.trim() ? `[[${cleanTarget}|${label}]]` : `[[${cleanTarget}]]`;
    case 'embed':
      return label.trim() ? `![[${cleanTarget}|${label}]]` : `![[${cleanTarget}]]`;
    case 'external':
      return `[${label}]( ${cleanTarget} )`.replace('( ', '(').replace(' )', ')');
    case 'image':
      return `![${label}](asset://${cleanTarget})`;
  }
}

export function parseMarkdownLink(value: string): MarkdownLinkValue | null {
  const wikilink = value.match(/^(!?)\[\[([^\]|\n]+?)(?:\|([^\]\n]*))?\]\]$/);
  if (wikilink) {
    return {
      kind: wikilink[1] ? 'embed' : 'wikilink',
      target: wikilink[2],
      label: wikilink[3] ?? '',
    };
  }
  const image = value.match(/^!\[([^\]]*)\]\(asset:\/\/([^\)]+)\)$/);
  if (image) return { kind: 'image', target: image[2], label: image[1] };
  const external = value.match(/^\[([^\]]+)\]\(([^\)]+)\)$/);
  if (external) return { kind: 'external', target: external[2], label: external[1] };
  return null;
}

function EntrySuggestions({
  universeId,
  currentEntryId,
  query,
  onSelect,
}: {
  universeId: string;
  currentEntryId?: string | null;
  query: string;
  onSelect: (entry: Entry) => void;
}) {
  const { data: entries = [] } = useEntries(universeId);
  const results = useMemo(
    () => rankEntries(entries, query, currentEntryId ?? null),
    [entries, query, currentEntryId],
  );

  if (results.length === 0) return null;
  return (
    <ul aria-label="Entry suggestions" className="mt-2 max-h-36 overflow-y-auto rounded border border-neutral-200 dark:border-neutral-700">
      {results.map((entry) => (
        <li key={entry.id}>
          <button
            type="button"
            className="w-full px-2 py-1 text-left text-sm hover:bg-neutral-100 dark:hover:bg-neutral-800"
            onClick={() => onSelect(entry)}
          >
            {entry.title}
          </button>
        </li>
      ))}
    </ul>
  );
}

export function MarkdownLinkDialog({
  open,
  onOpenChange,
  onInsert,
  universeId,
  currentEntryId = null,
  initialKind = 'wikilink',
  initialTarget = '',
  initialLabel,
  entries,
}: MarkdownLinkDialogProps) {
  const queryClient = useContext(QueryClientContext);
  const [kind, setKind] = useState<MarkdownLinkKind>(initialKind);
  const [target, setTarget] = useState(initialTarget);
  const [label, setLabel] = useState(initialLabel ?? (initialKind === 'external' ? 'Link' : ''));
  const [assetPickerOpen, setAssetPickerOpen] = useState(false);
  const targetRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setKind(initialKind);
    setTarget(initialTarget);
    setLabel(initialLabel ?? (initialKind === 'external' ? 'Link' : ''));
  }, [open, initialKind, initialTarget, initialLabel]);

  const canInsert = target.trim().length > 0 && (kind !== 'external' || label.trim().length > 0);
  const insert = () => {
    if (!canInsert) return;
    onInsert(buildMarkdownLink({ kind, target, label }));
    onOpenChange(false);
  };

  const selectAsset = (assetId: string, asset?: AssetSummary) => {
    setTarget(assetId);
    if (!label && asset?.altText) setLabel(asset.altText);
    setAssetPickerOpen(false);
  };

  return (
    <>
      <Dialog.Root open={open} onOpenChange={onOpenChange}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-40 bg-black/50" />
          <Dialog.Content
            aria-describedby={undefined}
            className="fixed left-1/2 top-1/2 z-50 w-[min(32rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 rounded-md border border-neutral-200 bg-white p-5 shadow-lg dark:border-neutral-800 dark:bg-neutral-900"
            onOpenAutoFocus={(event) => {
              event.preventDefault();
              targetRef.current?.focus();
            }}
          >
            <Dialog.Title className="text-lg font-semibold">Insert Markdown link</Dialog.Title>
            <div className="mt-4 flex flex-wrap gap-1" role="group" aria-label="Link type">
              {(['wikilink', 'embed', 'external', 'image'] as MarkdownLinkKind[]).map((option) => (
                <button
                  key={option}
                  type="button"
                  aria-pressed={kind === option}
                  onClick={() => {
                    setKind(option);
                    if (option === 'external' && !label) setLabel('Link');
                  }}
                  className="rounded border border-neutral-300 px-2 py-1 text-xs dark:border-neutral-700"
                >
                  {option === 'wikilink' ? 'Wikilink' : option === 'embed' ? 'Embed' : option === 'external' ? 'External URL' : 'Asset image'}
                </button>
              ))}
            </div>

            <label className="mt-4 block text-sm" htmlFor="markdown-link-target">{kind === 'external' ? 'URL' : kind === 'image' ? 'Asset ID' : 'Link target'}</label>
            <input
              ref={targetRef}
              id="markdown-link-target"
              aria-label="Link target"
              value={target}
              onChange={(event) => setTarget(event.target.value)}
              className="mt-1 w-full rounded border border-neutral-300 bg-transparent px-2 py-1.5 text-sm dark:border-neutral-700"
              autoComplete="off"
            />
            {kind === 'image' && (
              <button type="button" className="mt-2 rounded border border-neutral-300 px-2 py-1 text-xs dark:border-neutral-700" onClick={() => setAssetPickerOpen(true)}>
                Choose existing or upload image
              </button>
            )}

            <label className="mt-3 block text-sm" htmlFor="markdown-link-label">{kind === 'external' ? 'Accessible text' : 'Display text / alt text'}</label>
            <input
              id="markdown-link-label"
              aria-label={kind === 'external' ? 'Accessible text' : 'Display text / alt text'}
              value={label}
              onChange={(event) => setLabel(event.target.value)}
              className="mt-1 w-full rounded border border-neutral-300 bg-transparent px-2 py-1.5 text-sm dark:border-neutral-700"
              autoComplete="off"
            />

            {(kind === 'wikilink' || kind === 'embed') && entries ? (
              <ul aria-label="Entry suggestions" className="mt-2 max-h-36 overflow-y-auto rounded border border-neutral-200 dark:border-neutral-700">
                {rankEntries(entries, target, currentEntryId).map((entry) => (
                  <li key={entry.id}>
                    <button type="button" className="w-full px-2 py-1 text-left text-sm hover:bg-neutral-100 dark:hover:bg-neutral-800" onClick={() => { setTarget(entry.title); if (!label) setLabel(''); }}>
                      {entry.title}
                    </button>
                  </li>
                ))}
              </ul>
            ) : (kind === 'wikilink' || kind === 'embed') && queryClient ? (
              <EntrySuggestions universeId={universeId} currentEntryId={currentEntryId} query={target} onSelect={(entry) => setTarget(entry.title)} />
            ) : null}

            <div className="mt-5 flex justify-end gap-2">
              <button type="button" onClick={() => onOpenChange(false)} className="rounded border border-neutral-300 px-3 py-1.5 text-sm dark:border-neutral-700">Cancel</button>
              <button type="button" disabled={!canInsert} onClick={insert} className="rounded bg-[color:var(--color-accent)] px-3 py-1.5 text-sm text-white disabled:opacity-50">Insert link</button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
      {assetPickerOpen && (
        <AssetPickerModal
          open
          onOpenChange={setAssetPickerOpen}
          universeId={universeId}
          mode="insert-embed"
          onSelect={selectAsset}
        />
      )}
    </>
  );
}
