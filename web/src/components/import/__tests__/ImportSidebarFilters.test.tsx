import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  ImportSidebarFilters,
  type ReviewFilters,
} from '../ImportSidebarFilters';

function makeFilters(overrides: Partial<ReviewFilters> = {}): ReviewFilters {
  return {
    status: 'all',
    categories: new Set<string>(),
    types: new Set<string>(),
    ...overrides,
  };
}

const DEFAULT_PROPS = {
  filters: makeFilters(),
  onChange: () => {},
  availableCategories: [
    { label: 'Characters', count: 12 },
    { label: 'Places', count: 5 },
    { label: '(Uncategorized)', count: 3 },
  ],
  availableTypes: [
    { label: 'concept', count: 8 },
    { label: 'entity', count: 4 },
  ],
  warningCount: 0,
  rejectedCount: 0,
  onRejectAllWithWarnings: () => {},
  onRejectAllInCategory: () => {},
  onRestoreAllRejected: () => {},
};

describe('ImportSidebarFilters', () => {
  it('renders Status, Category, Type, and Bulk actions section headings', () => {
    render(<ImportSidebarFilters {...DEFAULT_PROPS} />);

    expect(screen.getByRole('heading', { name: /status/i, level: 3 })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /category/i, level: 3 })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /^type$/i, level: 3 })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /bulk actions/i, level: 3 })).toBeInTheDocument();
  });

  it('wraps content in <nav aria-label="Review filters">', () => {
    render(<ImportSidebarFilters {...DEFAULT_PROPS} />);
    const nav = screen.getByRole('navigation', { name: /review filters/i });
    expect(nav).toBeInTheDocument();
  });

  it('renders one Category row per availableCategories with the (count) suffix', () => {
    render(<ImportSidebarFilters {...DEFAULT_PROPS} />);

    expect(screen.getByText('Characters')).toBeInTheDocument();
    expect(screen.getByText('Places')).toBeInTheDocument();
    expect(screen.getByText('(Uncategorized)')).toBeInTheDocument();
    // Counts (use the "12", "5", "3" presence — they appear in the row)
    expect(screen.getByText('12')).toBeInTheDocument();
    expect(screen.getByText('5')).toBeInTheDocument();
    expect(screen.getByText('3')).toBeInTheDocument();
  });

  it('clicking a Status radio fires onChange with the new status value', async () => {
    const onChange = vi.fn();
    render(<ImportSidebarFilters {...DEFAULT_PROPS} onChange={onChange} />);

    const acceptedRadio = screen.getByRole('radio', { name: /accepted only/i });
    await userEvent.click(acceptedRadio);

    expect(onChange).toHaveBeenCalledTimes(1);
    const next = onChange.mock.calls[0][0] as ReviewFilters;
    expect(next.status).toBe('accepted');
  });

  it('checking a Category checkbox (when Set is empty) adds the label to the Set in onChange', async () => {
    const onChange = vi.fn();
    render(<ImportSidebarFilters {...DEFAULT_PROPS} onChange={onChange} />);

    const charactersCheckbox = screen.getByRole('checkbox', { name: /Characters/i });
    await userEvent.click(charactersCheckbox);

    expect(onChange).toHaveBeenCalledTimes(1);
    const next = onChange.mock.calls[0][0] as ReviewFilters;
    expect(next.categories).toBeInstanceOf(Set);
    expect(next.categories.has('Characters')).toBe(true);
    expect(next.categories.size).toBe(1);
  });

  it('Reject all with warnings: label includes the warning count; disabled when 0; enabled and fires callback when > 0', async () => {
    // Disabled
    const { unmount } = render(
      <ImportSidebarFilters {...DEFAULT_PROPS} warningCount={0} />,
    );
    const btn0 = screen.getByRole('button', { name: /reject all with warnings/i });
    expect(btn0.textContent).toMatch(/\(0\)/);
    expect(btn0).toBeDisabled();
    unmount();

    // Enabled
    const onRejectAllWithWarnings = vi.fn();
    render(
      <ImportSidebarFilters
        {...DEFAULT_PROPS}
        warningCount={4}
        onRejectAllWithWarnings={onRejectAllWithWarnings}
      />,
    );
    const btn4 = screen.getByRole('button', { name: /reject all with warnings/i });
    expect(btn4.textContent).toMatch(/\(4\)/);
    expect(btn4).not.toBeDisabled();
    await userEvent.click(btn4);
    expect(onRejectAllWithWarnings).toHaveBeenCalledTimes(1);
  });

  it('Reject all in <category>: disabled with placeholder label when categories.size !== 1; enabled with category name when size === 1', async () => {
    // size 0 → disabled, label "Reject all in …"
    const { unmount } = render(<ImportSidebarFilters {...DEFAULT_PROPS} />);
    const btn0 = screen.getByRole('button', { name: /reject all in/i });
    expect(btn0.textContent).toMatch(/Reject all in …/);
    expect(btn0).toBeDisabled();
    unmount();

    // size 2 → disabled
    const { unmount: unmount2 } = render(
      <ImportSidebarFilters
        {...DEFAULT_PROPS}
        filters={makeFilters({ categories: new Set(['Characters', 'Places']) })}
      />,
    );
    const btn2 = screen.getByRole('button', { name: /reject all in/i });
    expect(btn2).toBeDisabled();
    unmount2();

    // size 1 → enabled, label includes the category name
    const onRejectAllInCategory = vi.fn();
    render(
      <ImportSidebarFilters
        {...DEFAULT_PROPS}
        filters={makeFilters({ categories: new Set(['Characters']) })}
        onRejectAllInCategory={onRejectAllInCategory}
      />,
    );
    const btn1 = screen.getByRole('button', { name: /reject all in characters/i });
    expect(btn1).not.toBeDisabled();
    await userEvent.click(btn1);
    expect(onRejectAllInCategory).toHaveBeenCalledTimes(1);
  });

  it('Restore N rejected: disabled when rejectedCount === 0; enabled when > 0; clicking calls onRestoreAllRejected', async () => {
    const { unmount } = render(
      <ImportSidebarFilters {...DEFAULT_PROPS} rejectedCount={0} />,
    );
    const btn0 = screen.getByRole('button', { name: /restore.*rejected/i });
    expect(btn0).toBeDisabled();
    unmount();

    const onRestoreAllRejected = vi.fn();
    render(
      <ImportSidebarFilters
        {...DEFAULT_PROPS}
        rejectedCount={7}
        onRestoreAllRejected={onRestoreAllRejected}
      />,
    );
    const btn7 = screen.getByRole('button', { name: /restore 7 rejected/i });
    expect(btn7).not.toBeDisabled();
    await userEvent.click(btn7);
    expect(onRestoreAllRejected).toHaveBeenCalledTimes(1);
  });

  it('clicking a checkbox that is already in the Set removes it (toggle off)', async () => {
    const onChange = vi.fn();
    render(
      <ImportSidebarFilters
        {...DEFAULT_PROPS}
        filters={makeFilters({ categories: new Set(['Characters']) })}
        onChange={onChange}
      />,
    );

    const charactersCheckbox = screen.getByRole('checkbox', { name: /Characters/i });
    expect(charactersCheckbox).toBeChecked();

    await userEvent.click(charactersCheckbox);

    expect(onChange).toHaveBeenCalledTimes(1);
    const next = onChange.mock.calls[0][0] as ReviewFilters;
    expect(next.categories.has('Characters')).toBe(false);
    expect(next.categories.size).toBe(0);
  });
});
