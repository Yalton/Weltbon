import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { EmptyState } from './EmptyState';

describe('EmptyState', () => {
  it('renders title, body, action, and constellation motif', () => {
    render(<EmptyState title="No maps yet" body="Create one." action={<button>New map</button>} />);
    expect(screen.getByRole('heading', { name: 'No maps yet' })).toBeInTheDocument();
    expect(screen.getByText('Create one.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'New map' })).toBeInTheDocument();
    expect(screen.getByTestId('empty-state-motif')).toBeInTheDocument();
  });

  it('omits optional parts', () => {
    render(<EmptyState title="Nothing here" />);
    expect(screen.getByRole('heading', { name: 'Nothing here' })).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});
