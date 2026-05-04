import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { PreviewEntry, CommitDecision } from '../../../types/ingestReview';
import { ImportListRow } from '../ImportListRow';

const baseEntry: PreviewEntry = {
  filename: 'foo.md',
  path: 'foo.md',
  title: 'Foo',
  type: 'concept',
  tags: [],
  category: null,
  body: '',
  meta: {},
  linksOut: [],
};

function makeEntry(overrides: Partial<PreviewEntry> = {}): PreviewEntry {
  return { ...baseEntry, ...overrides };
}

describe('ImportListRow', () => {
  it('renders the title and type-badge for an accept disposition with no warnings, no chip, no glyph', () => {
    render(
      <ImportListRow
        entry={makeEntry()}
        decision={{ disposition: 'accept' }}
        effectiveTitle="Foo"
        conflictTitle={null}
        isFocused={false}
        onFocus={() => {}}
      />,
    );

    expect(screen.getByText('Foo')).toBeInTheDocument();
    expect(screen.getByText('concept')).toBeInTheDocument();
    // No chip
    expect(screen.queryByText('Conflict')).not.toBeInTheDocument();
    expect(screen.queryByText(/Renamed/)).not.toBeInTheDocument();
    // No reject glyph
    expect(screen.queryByLabelText('Rejected')).not.toBeInTheDocument();
    // No warnings glyph
    expect(screen.queryByLabelText(/warnings/)).not.toBeInTheDocument();
  });

  it('rejected disposition renders strikethrough title, the reject glyph (aria-label "Rejected"), and the rejected-tinted bg class', () => {
    const { container } = render(
      <ImportListRow
        entry={makeEntry()}
        decision={{ disposition: 'reject' }}
        effectiveTitle="Foo"
        conflictTitle={null}
        isFocused={false}
        onFocus={() => {}}
      />,
    );

    const rejectGlyph = screen.getByLabelText('Rejected');
    expect(rejectGlyph).toBeInTheDocument();
    expect(rejectGlyph.textContent).toBe('✘');

    // Title should have line-through class
    const title = screen.getByText('Foo');
    expect(title.className).toMatch(/line-through/);
    expect(title.className).toMatch(/text-neutral-500/);

    // Outer button should have rejected tinted bg
    const button = container.querySelector('button');
    expect(button?.className).toMatch(/bg-neutral-100\/50/);
  });

  it('skip disposition with conflictTitle renders ConflictChip variant=skip with sr-only matchedTitle text', () => {
    render(
      <ImportListRow
        entry={makeEntry({ title: 'My Character' })}
        decision={{ disposition: 'skip' }}
        effectiveTitle="My Character"
        conflictTitle="My Character"
        isFocused={false}
        onFocus={() => {}}
      />,
    );

    // Visible chip text is "Conflict" (uppercase per spec)
    expect(screen.getByText('Conflict')).toBeInTheDocument();
    // sr-only text mentions matched title
    expect(
      screen.getByText(/matches "My Character" already in universe/i),
    ).toBeInTheDocument();
  });

  it('rename disposition with conflictTitle renders effectiveTitle and "→ Renamed" chip', () => {
    render(
      <ImportListRow
        entry={makeEntry({ title: 'Foo' })}
        decision={{ disposition: 'rename', newTitle: 'Foo (2)' }}
        effectiveTitle="Foo (2)"
        conflictTitle="Foo"
        isFocused={false}
        onFocus={() => {}}
      />,
    );

    // effectiveTitle is the visible title (parent computed)
    expect(screen.getByText('Foo (2)')).toBeInTheDocument();
    // Renamed chip
    expect(screen.getByText('→ Renamed')).toBeInTheDocument();
    // sr-only text mentions the original conflict title
    expect(
      screen.getByText(/Renamed to avoid conflict with "Foo"/i),
    ).toBeInTheDocument();
  });

  it('renders the warning glyph with a count derived from unresolved linksOut', () => {
    const entry = makeEntry({
      linksOut: [
        { target: 'a', label: 'a', resolved: false },
        { target: 'b', label: 'b', resolved: false },
        { target: 'c', label: 'c', resolved: true },
      ],
    });

    render(
      <ImportListRow
        entry={entry}
        decision={{ disposition: 'accept' }}
        effectiveTitle="Foo"
        conflictTitle={null}
        isFocused={false}
        onFocus={() => {}}
      />,
    );

    const warning = screen.getByLabelText('2 warnings');
    expect(warning).toBeInTheDocument();
    expect(warning.textContent).toBe('⚠');
  });

  it('focused row renders aria-selected="true", accent-bg/border-l class, and clicking calls onFocus', async () => {
    const onFocus = vi.fn();
    const { container } = render(
      <ImportListRow
        entry={makeEntry()}
        decision={{ disposition: 'accept' }}
        effectiveTitle="Foo"
        conflictTitle={null}
        isFocused={true}
        onFocus={onFocus}
      />,
    );

    const button = container.querySelector('button')!;
    expect(button.getAttribute('aria-selected')).toBe('true');
    expect(button.getAttribute('aria-current')).toBe('true');
    expect(button.getAttribute('role')).toBe('option');
    // Accent recipe present
    expect(button.className).toMatch(/border-l-\[color:var\(--color-accent\)\]/);
    expect(button.className).toMatch(/bg-\[color:var\(--color-accent\)\]\/10/);

    await userEvent.click(button);
    expect(onFocus).toHaveBeenCalledTimes(1);
  });

  it('non-focused row renders idle border-l-transparent + neutral hover class (and aria-current absent)', () => {
    const { container } = render(
      <ImportListRow
        entry={makeEntry()}
        decision={{ disposition: 'accept' }}
        effectiveTitle="Foo"
        conflictTitle={null}
        isFocused={false}
        onFocus={() => {}}
      />,
    );

    const button = container.querySelector('button')!;
    expect(button.getAttribute('aria-selected')).toBe('false');
    // aria-current omitted (or absent) when not focused
    expect(button.hasAttribute('aria-current')).toBe(false);
    expect(button.className).toMatch(/border-l-transparent/);
    expect(button.className).toMatch(/hover:bg-neutral-100/);
  });

  it('class strings are static (no template-string concat present in the rendered classes)', () => {
    // Render twice, focused vs idle, and confirm the literal class names from
    // the spec are present verbatim. This is a smoke check; the grep in the
    // <done> section enforces the static-class contract at the source level.
    const { container: focusedContainer } = render(
      <ImportListRow
        entry={makeEntry()}
        decision={{ disposition: 'accept' }}
        effectiveTitle="Foo"
        conflictTitle={null}
        isFocused={true}
        onFocus={() => {}}
      />,
    );
    const focused = focusedContainer.querySelector('button')!.className;
    expect(focused).toContain('border-l-[color:var(--color-accent)]');
    expect(focused).toContain('bg-[color:var(--color-accent)]/10');

    const { container: idleContainer } = render(
      <ImportListRow
        entry={makeEntry()}
        decision={{ disposition: 'accept' }}
        effectiveTitle="Foo"
        conflictTitle={null}
        isFocused={false}
        onFocus={() => {}}
      />,
    );
    const idle = idleContainer.querySelector('button')!.className;
    expect(idle).toContain('border-l-transparent');
    expect(idle).toContain('hover:bg-neutral-100');
  });

  it('renders an icon (first character of title, uppercased) in the row icon slot', () => {
    render(
      <ImportListRow
        entry={makeEntry({ title: 'foo bar' })}
        decision={{ disposition: 'accept' }}
        effectiveTitle="foo bar"
        conflictTitle={null}
        isFocused={false}
        onFocus={() => {}}
      />,
    );

    // Icon span renders 'F' (first-char uppercased)
    expect(screen.getByText('F')).toBeInTheDocument();
  });
});

// Sanity: the "rename" disposition with a CommitDecision shape requires newTitle
// — ensure TS happy at compile time without affecting runtime.
const _exhaustive: CommitDecision = { disposition: 'rename', newTitle: 'x' };
void _exhaustive;
