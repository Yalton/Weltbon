import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { EntryCard } from './EntryCard';
import type { Entry } from '../hooks/useEntries';

function makeEntry(overrides: Partial<Entry> = {}): Entry {
  return {
    id: 'e1',
    universeId: 'u1',
    title: 'Aldric',
    entryType: 'entity',
    summary: 'A wandering knight',
    tags: [],
    aliases: [],
    meta: {},
    icon: '',
    categoryId: null,
    isPublic: false,
    wip: false,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

describe('EntryCard', () => {
  it('leads the row with the cover thumbnail when the entry has one', () => {
    const { container } = render(<EntryCard entry={makeEntry({ coverThumbUrl: '/thumb-1.png' })} />);
    // The medallion cover is decorative (alt=""), so it has no img role — query by attribute.
    const cover = container.querySelector('[data-medallion="cover"]');
    expect(cover).toHaveAttribute('src', '/thumb-1.png');
  });

  it('leads with the emoji when the entry has an icon but no cover', () => {
    const { container } = render(<EntryCard entry={makeEntry({ icon: '👑' })} />);
    expect(container.querySelector('[data-medallion="icon"]')).toBeInTheDocument();
    expect(screen.getByText('👑')).toBeInTheDocument();
  });

  it('leads with the illuminated monogram when there is neither cover nor icon', () => {
    const { container } = render(<EntryCard entry={makeEntry()} />);
    expect(container.querySelector('[data-medallion="monogram"]')).toBeInTheDocument();
    expect(screen.getByText('A')).toBeInTheDocument();
  });

  it('no longer renders the gray placeholder circle', () => {
    // The whole point of the change: an entry with no art used to show a dead gray dot.
    // Asserted as "exactly one medallion leads the row" rather than as the absence of a
    // renameable utility class — the row can only be right if the medallion is what's there.
    const { container } = render(<EntryCard entry={makeEntry()} />);
    expect(container.querySelectorAll('[data-medallion]')).toHaveLength(1);
    expect(container.querySelector('.bg-neutral-300')).toBeNull();
  });

  it('sets the title in the display serif', () => {
    render(<EntryCard entry={makeEntry()} />);
    expect(screen.getByText('Aldric').className).toContain('font-display');
  });

  it('keeps the type badge, the WIP pill and the summary', () => {
    render(<EntryCard entry={makeEntry({ wip: true })} />);
    expect(screen.getByText('entity')).toBeInTheDocument();
    expect(screen.getByText('A wandering knight')).toBeInTheDocument();
  });
});
