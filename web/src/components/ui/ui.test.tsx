import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Button } from './Button';
import { Panel } from './Panel';
import { Input } from './Input';
import { PageHeader } from './PageHeader';

describe('Button', () => {
  it('renders children and fires onClick', async () => {
    const onClick = vi.fn();
    render(<Button onClick={onClick}>Create entry</Button>);
    await userEvent.click(screen.getByRole('button', { name: 'Create entry' }));
    expect(onClick).toHaveBeenCalledOnce();
  });

  it('applies variant classes', () => {
    const { rerender } = render(<Button>go</Button>);
    expect(screen.getByRole('button')).toHaveClass('from-indigo-400');
    rerender(<Button variant="ghost">go</Button>);
    expect(screen.getByRole('button')).toHaveClass('border-glass-border');
    rerender(<Button variant="danger">go</Button>);
    expect(screen.getByRole('button')).toHaveClass('text-rose-300');
  });

  it('respects disabled', () => {
    render(<Button disabled>go</Button>);
    expect(screen.getByRole('button')).toBeDisabled();
  });
});

describe('Panel', () => {
  it('renders children with glass classes', () => {
    render(<Panel data-testid="p">content</Panel>);
    const el = screen.getByTestId('p');
    expect(el).toHaveTextContent('content');
    expect(el).toHaveClass('bg-glass', 'border-glass-border');
  });

  it('adds hover treatment only when hover is set', () => {
    const { rerender } = render(<Panel data-testid="p" />);
    expect(screen.getByTestId('p')).not.toHaveClass('hover:shadow-glow-soft');
    rerender(<Panel data-testid="p" hover />);
    expect(screen.getByTestId('p')).toHaveClass('hover:shadow-glow-soft');
  });
});

describe('Input', () => {
  it('forwards props and accepts typing', async () => {
    render(<Input placeholder="Search entries…" />);
    const input = screen.getByPlaceholderText('Search entries…');
    await userEvent.type(input, 'Aldenmark');
    expect(input).toHaveValue('Aldenmark');
  });
});

describe('PageHeader', () => {
  it('renders title as h1, subtitle, and actions', () => {
    render(
      <PageHeader title="Entries" subtitle="3 entries" actions={<button>New</button>} />,
    );
    expect(screen.getByRole('heading', { level: 1, name: 'Entries' })).toBeInTheDocument();
    expect(screen.getByText('3 entries')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'New' })).toBeInTheDocument();
  });
});
