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
          assets={[]}
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
          assets={[]}
          entries={[]}
          onRevealSelection={vi.fn()}
          onReplaceAsset={vi.fn()}
        />
      </MemoryRouter>,
    );

    expect(screen.getByText(/backlinks appear after you save/i)).toBeInTheDocument();
    expect(screen.getByText(/no raw references or missing images need recovery/i)).toBeInTheDocument();
  });

  it('uses the canonical asset list to recover a deleted UUID-shaped reference', () => {
    const deletedAssetId = '123e4567-e89b-12d3-a456-426614174000';
    const markdown = `![Deleted map](asset://${deletedAssetId})`;

    render(
      <MemoryRouter>
        <MarkdownBacklinks
          universeId="U1"
          backlinks={[]}
          draftMarkdown={markdown}
          savedMarkdown={markdown}
          savedAssetUrls={{ [deletedAssetId]: '/api/universes/U1/assets/fallback/raw' }}
          assets={[]}
          entries={[]}
          onRevealSelection={vi.fn()}
          onReplaceAsset={vi.fn()}
        />
      </MemoryRouter>,
    );

    expect(screen.getByRole('button', { name: /replace image/i })).toBeInTheDocument();
  });

  it('only offers recovery for supported Markdown, excluding fences, raw blocks, and inline code', () => {
    const markdown = [
      '```md',
      '[[fenced-link]]',
      '![Fenced image](asset://fenced-asset)',
      '```',
      '',
      '`[[inline-link]]` `![Inline image](asset://inline-asset)`',
      '',
      ':::mermaid',
      '[[raw-link]]',
      '![Raw image](asset://raw-asset)',
      ':::',
      '',
      '[[supported-link]]',
      '![Supported image](asset://supported-asset)',
    ].join('\n');

    render(
      <MemoryRouter>
        <MarkdownBacklinks
          universeId="U1"
          backlinks={[]}
          draftMarkdown={markdown}
          savedMarkdown={markdown}
          savedAssetUrls={{}}
          assets={[]}
          entries={[]}
          onRevealSelection={vi.fn()}
          onReplaceAsset={vi.fn()}
        />
      </MemoryRouter>,
    );

    expect(screen.getByText('[[supported-link]]')).toBeInTheDocument();
    expect(screen.queryByText('[[fenced-link]]')).not.toBeInTheDocument();
    expect(screen.queryByText('[[raw-link]]')).not.toBeInTheDocument();
    expect(screen.queryByText('[[inline-link]]')).not.toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /replace image/i })).toHaveLength(1);
  });

  it('excludes fenced code nested in blockquotes and list items from recovery', () => {
    const markdown = [
      '> ```md',
      '> ![Quoted code](asset://quoted-code)',
      '> ```',
      '',
      '- ```md',
      '  ![Listed code](asset://listed-code)',
      '  ```',
      '',
      '![Supported image](asset://supported-image)',
    ].join('\n');

    render(
      <MemoryRouter>
        <MarkdownBacklinks
          universeId="U1"
          backlinks={[]}
          draftMarkdown={markdown}
          savedMarkdown={markdown}
          savedAssetUrls={{}}
          assets={[]}
          entries={[]}
          onRevealSelection={vi.fn()}
          onReplaceAsset={vi.fn()}
        />
      </MemoryRouter>,
    );

    expect(screen.getByText('![Supported image](asset://supported-image)')).toBeInTheDocument();
    expect(screen.queryByText('![Quoted code](asset://quoted-code)')).not.toBeInTheDocument();
    expect(screen.queryByText('![Listed code](asset://listed-code)')).not.toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /replace image/i })).toHaveLength(1);
  });
});
