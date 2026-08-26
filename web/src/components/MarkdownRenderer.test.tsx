/**
 * Phase 32 Plan 04 Task 1 — MarkdownRenderer + WikilinkText + WordPopover tests.
 *
 * Covers per the plan's acceptance criteria (≥5 cases):
 *   T1. D-01 precedence: entry-title beats same-spelling dictionary word
 *   T2. Resolved dictionary word: accent-soft span with popover (gloss+ipa)
 *   T3. Unresolved [[word]]: amber missing span + "+" add button
 *   T4. Code span `[[x]]`: NOT resolved (literal code rendering)
 *   T5. No-wikis prop: [[x]] renders as literal text (backwards-compat)
 *   T6. Share/read-only path: unresolved span renders WITHOUT "+" add button
 *       when onAddWord is absent
 *   T7. Alias [[word|Alias]] resolves on "word" but displays "Alias"
 *   T8. Share-mode entry-title wikilink navigates to /share/:token/entries/:id
 *       (Phase 33 INT-BLOCKER-2 fix)
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { ReactNode } from 'react';
import { MarkdownRenderer } from './MarkdownRenderer';
import type { WikilinkResolutionData } from './WikilinkText';
import type { DictionaryWord } from '../hooks/useDictionary';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function Wrapper({ children }: { children: ReactNode }) {
  return <MemoryRouter>{children}</MemoryRouter>;
}

function makeDictWord(overrides: Partial<DictionaryWord> = {}): DictionaryWord {
  return {
    id: '00000000-0000-4000-8000-000000000001',
    universeId: 'u1',
    languageEntryId: null,
    word: 'mellon',
    ipa: 'ˈmɛlɒn',
    partOfSpeech: 'noun',
    gloss: 'friend',
    etymology: '',
    tags: [],
    createdAt: '2026-06-01T00:00:00Z',
    updatedAt: '2026-06-01T00:00:00Z',
    ...overrides,
  };
}

function makeWikis(overrides: Partial<WikilinkResolutionData> = {}): WikilinkResolutionData {
  return {
    entryTitles: new Map(),
    dictionaryWords: new Map(),
    universeId: 'u1',
    languageEntryId: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// T1 — D-01 precedence: entry-title beats dictionary word of the same spelling
// ---------------------------------------------------------------------------

describe('T1: D-01 precedence — entry-title wins over dictionary word', () => {
  it('renders an entry link when the token matches BOTH entryTitles and dictionaryWords', () => {
    const entryTitles = new Map([['mellon', 'entry-42']]);
    const dictionaryWords = new Map([['mellon', makeDictWord()]]);
    const wikis = makeWikis({ entryTitles, dictionaryWords });

    render(
      <Wrapper>
        <MarkdownRenderer content="See [[mellon]] for more." wikis={wikis} />
      </Wrapper>,
    );

    // Should be a Link to /universes/u1/entries/entry-42
    const link = screen.getByRole('link', { name: 'mellon' });
    expect(link).toHaveAttribute('href', '/universes/u1/entries/entry-42');

    // The WordPopover trigger (role=button) must NOT be present
    expect(screen.queryByRole('button', { name: /hover to see gloss/i })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// T2 — Resolved dictionary word: WordPopover trigger present, shows gloss+ipa
// ---------------------------------------------------------------------------

describe('T2: resolved dictionary word renders WordPopover trigger', () => {
  it('renders accent-soft span with aria-label "word: hover to see gloss"', () => {
    const dictionaryWords = new Map([['mellon', makeDictWord()]]);
    const wikis = makeWikis({ dictionaryWords });

    render(
      <Wrapper>
        <MarkdownRenderer content="Say [[mellon]] and pass." wikis={wikis} />
      </Wrapper>,
    );

    // WordPopover trigger is a role=button span
    const trigger = screen.getByRole('button', { name: /mellon: hover to see gloss/i });
    expect(trigger).toBeInTheDocument();
    // The IPA is present in the popover content but we can also assert the
    // trigger text is the word label
    expect(trigger).toHaveTextContent('mellon');
  });
});

// ---------------------------------------------------------------------------
// T3 — Unresolved [[word]]: amber span + "+" add button
// ---------------------------------------------------------------------------

describe('T3: unresolved [[word]] renders missing affordance with add button', () => {
  it('renders amber span and add button when onAddWord is provided', () => {
    const onAddWord = vi.fn();
    const wikis = makeWikis({ onAddWord });

    render(
      <Wrapper>
        <MarkdownRenderer content="Unknown [[zzz]] word." wikis={wikis} />
      </Wrapper>,
    );

    // Amber span aria-label
    expect(screen.getByLabelText('zzz — not found in dictionary')).toBeInTheDocument();

    // "+" add button
    const addBtn = screen.getByRole('button', { name: /Add zzz to dictionary/i });
    expect(addBtn).toBeInTheDocument();

    // Click calls onAddWord with the token
    addBtn.click();
    expect(onAddWord).toHaveBeenCalledWith('zzz');
  });
});

// ---------------------------------------------------------------------------
// T4 — Code span `[[x]]` is NOT resolved
// ---------------------------------------------------------------------------

describe('T4: inline code span [[x]] is NOT resolved', () => {
  it('does not resolve [[x]] inside a code span', () => {
    const onAddWord = vi.fn();
    const dictionaryWords = new Map([['mellon', makeDictWord()]]);
    const wikis = makeWikis({ dictionaryWords, onAddWord });

    render(
      <Wrapper>
        <MarkdownRenderer content="Write `[[mellon]]` verbatim." wikis={wikis} />
      </Wrapper>,
    );

    // The WordPopover trigger must NOT be present (code span is not scanned)
    expect(screen.queryByRole('button', { name: /hover to see gloss/i })).toBeNull();

    // onAddWord must NOT have been called
    expect(onAddWord).not.toHaveBeenCalled();

    // The raw literal text [[mellon]] should be rendered inside <code>
    const code = document.querySelector('code');
    expect(code).toBeTruthy();
    expect(code?.textContent).toContain('[[mellon]]');
  });
});

// ---------------------------------------------------------------------------
// T5 — No-wikis prop: [[x]] renders as literal text (backwards-compat)
// ---------------------------------------------------------------------------

describe('T5: no wikis prop → [[x]] renders as literal text', () => {
  it('renders [[x]] as plain text when wikis prop is absent', () => {
    render(
      <Wrapper>
        <MarkdownRenderer content="A [[word]] in plain markdown." />
      </Wrapper>,
    );

    // No resolution links or buttons
    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.queryByRole('button')).toBeNull();

    // The raw wikilink syntax appears as text
    expect(screen.getByText(/\[\[word\]\]/)).toBeInTheDocument();
  });
});

describe('authoring callouts', () => {
  it('marks supported NOTE callouts for the reading surface without changing their body', () => {
    render(<MarkdownRenderer content={'> [!NOTE]\n> Keep this detail.'} />);

    const callout = document.querySelector('[data-callout-type="NOTE"]');
    expect(callout).toBeInTheDocument();
    expect(callout).toHaveTextContent('[!NOTE]');
    expect(callout).toHaveTextContent('Keep this detail.');
  });

  it('leaves unsupported callout types as ordinary blockquotes', () => {
    const { container } = render(<MarkdownRenderer content={'> [!DANGER]\n> Keep this raw.'} />);

    expect(container.querySelector('[data-callout-type]')).toBeNull();
    expect(container.querySelector('blockquote')).toHaveTextContent('[!DANGER]');
  });

  it('does not classify a real blockquote from a callout marker inside a fenced code block', () => {
    const content = '```md\n> [!NOTE]\n> This is code.\n```\n\n> [!DANGER]\n> Keep this unsupported.';
    const { container } = render(<MarkdownRenderer content={content} />);

    expect(container.querySelector('[data-callout-type]')).toBeNull();
    expect(container.querySelector('blockquote')).toHaveTextContent('[!DANGER]');
  });

  it.each([
    ['a list fence', '- ~~~md\n  > [!NOTE]\n  > This is code.\n  ~~~\n\n> [!DANGER]\n> Keep this unsupported.'],
    ['a blockquote fence', '> ~~~md\n> [!NOTE]\n> This is code.\n> ~~~\n\n> [!DANGER]\n> Keep this unsupported.'],
  ])('does not classify the following unsupported callout after %s', (_description, content) => {
    const { container } = render(<MarkdownRenderer content={content} />);

    expect(container.querySelector('[data-callout-type]')).toBeNull();
    expect(container).toHaveTextContent('[!DANGER]');
  });

  it('does not promote a later paragraph marker in an ordinary blockquote', () => {
    const content = '> prose\n>\n> [!NOTE]\n> This remains ordinary text.';
    const { container } = render(<MarkdownRenderer content={content} />);

    expect(container.querySelector('[data-callout-type]')).toBeNull();
    expect(container.querySelector('blockquote')).toHaveTextContent('[!NOTE]');
  });
});

// ---------------------------------------------------------------------------
// T6 — Share/read-only path: "+" add button ABSENT when onAddWord is absent
// ---------------------------------------------------------------------------

describe('T6: share/read-only — unresolved span omits add button without onAddWord', () => {
  it('renders the amber unresolved span but NO add button in share mode', () => {
    // No onAddWord prop → share / read-only path
    const wikis = makeWikis(); // no onAddWord

    render(
      <Wrapper>
        <MarkdownRenderer content="Missing [[zzz]] word." wikis={wikis} />
      </Wrapper>,
    );

    // Amber span present
    expect(screen.getByLabelText('zzz — not found in dictionary')).toBeInTheDocument();

    // "+" add button must NOT be present
    expect(screen.queryByRole('button', { name: /Add zzz to dictionary/i })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// T7 — Alias: [[word|Alias]] resolves on "word", displays "Alias"
// ---------------------------------------------------------------------------

describe('T7: alias [[word|Alias]] resolves on "word" and displays "Alias"', () => {
  it('displays alias label for a resolved dictionary word', () => {
    const dictionaryWords = new Map([['mellon', makeDictWord()]]);
    const wikis = makeWikis({ dictionaryWords });

    render(
      <Wrapper>
        <MarkdownRenderer content="Say [[mellon|Friend]] and pass." wikis={wikis} />
      </Wrapper>,
    );

    // WordPopover trigger should use the alias as display text
    const trigger = screen.getByRole('button', { name: /mellon: hover to see gloss/i });
    // aria-label uses the resolved word ("mellon"), display shows "Friend"
    expect(trigger).toHaveTextContent('Friend');
  });

  it('displays alias label for a resolved entry title', () => {
    // Phase 45 D-03: entryTitles keyed on lower(title.trim()) from Phase 45 onward.
    const entryTitles = new Map([['aragorn', 'entry-99']]);
    const wikis = makeWikis({ entryTitles });

    render(
      <Wrapper>
        <MarkdownRenderer content="See [[Aragorn|The King]]." wikis={wikis} />
      </Wrapper>,
    );

    const link = screen.getByRole('link', { name: 'The King' });
    expect(link).toHaveAttribute('href', '/universes/u1/entries/entry-99');
  });
});

// ---------------------------------------------------------------------------
// T8 — Share-mode entry-title wikilink navigates to /share/:token/entries/:id
// (Phase 33 INT-BLOCKER-2 fix)
// ---------------------------------------------------------------------------

describe('T8: share-mode entry-title wikilink uses /share/:token/entries/:id', () => {
  it('generates a share-subtree href when isShareMode=true and shareToken is set', () => {
    // Phase 45 D-03: entryTitles keyed on lower(title.trim()) from Phase 45 onward.
    const entryTitles = new Map([['gondor', 'entry-55']]);
    const wikis = makeWikis({
      entryTitles,
      isShareMode: true,
      shareToken: 'tok_abc123',
    });

    render(
      <Wrapper>
        <MarkdownRenderer content="See [[Gondor]] for details." wikis={wikis} />
      </Wrapper>,
    );

    const link = screen.getByRole('link', { name: 'Gondor' });
    expect(link).toHaveAttribute('href', '/share/tok_abc123/entries/entry-55');
  });

  it('falls back to authenticated path when isShareMode is absent (default behavior)', () => {
    // Phase 45 D-03: entryTitles keyed on lower(title.trim()) from Phase 45 onward.
    const entryTitles = new Map([['gondor', 'entry-55']]);
    const wikis = makeWikis({ entryTitles }); // no isShareMode

    render(
      <Wrapper>
        <MarkdownRenderer content="See [[Gondor]] for details." wikis={wikis} />
      </Wrapper>,
    );

    const link = screen.getByRole('link', { name: 'Gondor' });
    expect(link).toHaveAttribute('href', '/universes/u1/entries/entry-55');
  });
});
