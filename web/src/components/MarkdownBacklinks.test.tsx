import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { MarkdownBacklinks } from './MarkdownBacklinks';
import type { Backlink, Entry } from '../hooks/useEntries';

function makeEntry(id: string, title: string, aliases: string[] = []): Entry {
  return {
    id,
    universeId: 'U1',
    title,
    entryType: 'place',
    summary: '',
    tags: [],
    aliases,
    meta: {},
    icon: '',
    categoryId: null,
    isPublic: true,
    wip: false,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  };
}

const BACKLINKS: Backlink[] = [
  {
    id: 'backlink-1',
    sourceEntryId: 'atlas-id',
    sourceTitle: 'Atlas',
    sourceIcon: '',
    label: 'mentions',
    linkType: null,
    direction: 'inbound',
  },
];

const DRAFT_MARKDOWN = `[[Atlas]]
[[Glossary]]

![Map](asset://lost-asset)`;

describe('MarkdownBacklinks', () => {
  it('renders canonical backlinks and conservative recovery rows', async () => {
    const onRevealSelection = vi.fn();
    const onReplaceAsset = vi.fn();
    render(
      <MemoryRouter>
        <MarkdownBacklinks
          universeId="U1"
          backlinks={BACKLINKS}
          draftMarkdown={DRAFT_MARKDOWN}
          savedMarkdown={DRAFT_MARKDOWN}
          savedAssetUrls={{}}
          entries={[makeEntry('atlas-id', 'Atlas'), makeEntry('empire-id', 'Empire', ['Imperium'])]}
          onRevealSelection={onRevealSelection}
          onReplaceAsset={onReplaceAsset}
        />
      </MemoryRouter>,
    );

    expect(screen.getByRole('link', { name: 'Atlas' })).toBeInTheDocument();
    expect(screen.queryByText('[[Atlas]]')).not.toBeInTheDocument();
    expect(screen.getByText('[[Glossary]]')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /open in source/i }));
    expect(onRevealSelection).toHaveBeenCalledWith({
      end: DRAFT_MARKDOWN.indexOf('[[Glossary]]') + '[[Glossary]]'.length,
      raw: '[[Glossary]]',
      start: DRAFT_MARKDOWN.indexOf('[[Glossary]]'),
    });

    await userEvent.click(screen.getByRole('button', { name: /replace image/i }));
    expect(onReplaceAsset).toHaveBeenCalledWith({
      altText: 'Map',
      end: DRAFT_MARKDOWN.indexOf('![Map](asset://lost-asset)') + '![Map](asset://lost-asset)'.length,
      raw: '![Map](asset://lost-asset)',
      start: DRAFT_MARKDOWN.indexOf('![Map](asset://lost-asset)'),
    });
  });

  it('shows meaningful empty states when nothing is available yet', () => {
    render(
      <MemoryRouter>
        <MarkdownBacklinks
          universeId="U1"
          backlinks={[]}
          draftMarkdown=""
          savedMarkdown=""
          savedAssetUrls={{}}
          entries={[]}
          onRevealSelection={vi.fn()}
          onReplaceAsset={vi.fn()}
        />
      </MemoryRouter>,
    );

    expect(screen.getByText(/backlinks appear after you save/i)).toBeInTheDocument();
    expect(screen.getByText(/no raw references or missing images need recovery/i)).toBeInTheDocument();
  });
});
