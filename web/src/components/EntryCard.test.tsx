import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { EntryCard } from './EntryCard';
import type { Entry } from '../hooks/useEntries';

function mkEntry(overrides: Partial<Entry> = {}): Entry {
  return {
    id: 'E1',
    universeId: 'U1',
    title: 'Gondor',
    entryType: 'location',
    summary: 'A kingdom of men',
    tags: [],
    meta: {},
    icon: '🏰',
    categoryId: null,
    wip: false,
    createdAt: '2025-01-01',
    updatedAt: '2025-01-01',
    ...overrides,
  };
}

describe('EntryCard WIP pill', () => {
  it('shows WipPill when entry.wip is true', () => {
    render(<EntryCard entry={mkEntry({ wip: true })} />);
    expect(screen.getByLabelText('Work in progress')).toBeInTheDocument();
    expect(screen.getByLabelText('Work in progress')).toHaveTextContent('WIP');
  });

  it('does not show WipPill when entry.wip is false', () => {
    render(<EntryCard entry={mkEntry({ wip: false })} />);
    expect(screen.queryByLabelText('Work in progress')).not.toBeInTheDocument();
  });

  it('does not show WipPill when entry.wip is undefined', () => {
    const entry = mkEntry();
    // Cast to simulate a legacy response without wip
    render(<EntryCard entry={{ ...entry, wip: undefined as unknown as boolean }} />);
    expect(screen.queryByLabelText('Work in progress')).not.toBeInTheDocument();
  });
});
