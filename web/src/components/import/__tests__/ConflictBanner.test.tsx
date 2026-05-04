import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { ConflictBanner } from '../ConflictBanner';

function renderBanner(
  overrides: Partial<React.ComponentProps<typeof ConflictBanner>> = {},
) {
  const onUpdateDecision = vi.fn();
  const props: React.ComponentProps<typeof ConflictBanner> = {
    matchedTitle: 'Foo',
    universeName: 'World',
    decision: { disposition: 'skip' },
    effectiveTitle: 'Foo',
    onUpdateDecision,
    originalTitle: 'Foo',
    existingTitlesLower: new Set<string>(['foo']),
    entryPath: 'notes/foo.md',
    ...overrides,
  };
  const utils = render(<ConflictBanner {...props} />);
  return { ...utils, onUpdateDecision };
}

describe('ConflictBanner', () => {
  it('renders heading "Conflict — title already exists in {universeName}" with skip-body copy when disposition=skip', () => {
    renderBanner({ decision: { disposition: 'skip' } });
    expect(
      screen.getByRole('heading', {
        name: /Conflict — title already exists in World/i,
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/An entry called "Foo" already exists/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/this entry will be skipped on commit/i)).toBeInTheDocument();
    // skip radio checked, rename unchecked
    const skipRadio = screen.getByLabelText('Skip') as HTMLInputElement;
    const renameRadio = screen.getByLabelText('Rename') as HTMLInputElement;
    expect(skipRadio.checked).toBe(true);
    expect(renameRadio.checked).toBe(false);
    // Helper note (rename-only) NOT present
    expect(screen.queryByText(/Original title was/i)).not.toBeInTheDocument();
  });

  it('renders rename-body copy + helper note when disposition=rename', () => {
    renderBanner({
      decision: { disposition: 'rename', newTitle: 'Foo (2)' },
      effectiveTitle: 'Foo (2)',
    });
    expect(
      screen.getByText(
        /Renaming this entry to "Foo \(2\)" so it imports without overwriting "Foo"/i,
      ),
    ).toBeInTheDocument();
    const skipRadio = screen.getByLabelText('Skip') as HTMLInputElement;
    const renameRadio = screen.getByLabelText('Rename') as HTMLInputElement;
    expect(skipRadio.checked).toBe(false);
    expect(renameRadio.checked).toBe(true);
    expect(screen.getByText(/Original title was "Foo"/i)).toBeInTheDocument();
  });

  it('clicking rename while in skip calls onUpdateDecision with { disposition: "rename", newTitle: "Foo (2)" }', async () => {
    const user = userEvent.setup();
    const { onUpdateDecision } = renderBanner({
      decision: { disposition: 'skip' },
      originalTitle: 'Foo',
      existingTitlesLower: new Set<string>(['foo']),
    });
    await user.click(screen.getByLabelText('Rename'));
    expect(onUpdateDecision).toHaveBeenCalledWith({
      disposition: 'rename',
      newTitle: 'Foo (2)',
    });
  });

  it('skips collisions when computing rename suffix — Foo (2) taken → Foo (3)', async () => {
    const user = userEvent.setup();
    const { onUpdateDecision } = renderBanner({
      decision: { disposition: 'skip' },
      originalTitle: 'Foo',
      existingTitlesLower: new Set<string>(['foo', 'foo (2)']),
    });
    await user.click(screen.getByLabelText('Rename'));
    expect(onUpdateDecision).toHaveBeenCalledWith({
      disposition: 'rename',
      newTitle: 'Foo (3)',
    });
  });

  it('skips multiple collisions — Foo (2) and Foo (3) taken → Foo (4)', async () => {
    const user = userEvent.setup();
    const { onUpdateDecision } = renderBanner({
      decision: { disposition: 'skip' },
      originalTitle: 'Foo',
      existingTitlesLower: new Set<string>(['foo', 'foo (2)', 'foo (3)']),
    });
    await user.click(screen.getByLabelText('Rename'));
    expect(onUpdateDecision).toHaveBeenCalledWith({
      disposition: 'rename',
      newTitle: 'Foo (4)',
    });
  });

  it('clicking skip while in rename calls onUpdateDecision with { disposition: "skip" } (rename intent discarded)', async () => {
    const user = userEvent.setup();
    const { onUpdateDecision } = renderBanner({
      decision: { disposition: 'rename', newTitle: 'Foo (2)' },
      effectiveTitle: 'Foo (2)',
    });
    await user.click(screen.getByLabelText('Skip'));
    expect(onUpdateDecision).toHaveBeenCalledWith({ disposition: 'skip' });
    // Make sure the call was not the rename shape
    expect(onUpdateDecision).not.toHaveBeenCalledWith(
      expect.objectContaining({ disposition: 'rename' }),
    );
  });

  it('container has role="region" (NOT "alert" — banner persists, not a transient announcement)', () => {
    renderBanner();
    const region = screen.getByRole('region');
    expect(region).toBeInTheDocument();
    // assert it's NOT an alert element
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('region is aria-labelledby the heading id', () => {
    renderBanner();
    const region = screen.getByRole('region');
    const labelledBy = region.getAttribute('aria-labelledby');
    expect(labelledBy).toBeTruthy();
    const heading = document.getElementById(labelledBy!);
    expect(heading).not.toBeNull();
    expect(heading!.tagName.toLowerCase()).toBe('h3');
    expect(heading!.textContent).toMatch(/Conflict — title already exists in World/i);
  });
});
