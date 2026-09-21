
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
  it('renders supported NOTE callouts without exposing the marker', () => {
    render(<MarkdownRenderer content={'> [!NOTE]\n> Keep this detail.'} />);

    const callout = document.querySelector('[data-callout-type="NOTE"]');
    expect(callout).toBeInTheDocument();
    expect(callout).not.toHaveTextContent('[!NOTE]');
    expect(callout).toHaveTextContent('Keep this detail.');
  });

  it.each(['TIP', 'WARNING', 'IMPORTANT'])(
    'renders %s callouts with the marker removed',
    (type) => {
      render(
        <MarkdownRenderer
          content={`> [!${type}]\n> Keep this ${type.toLowerCase()} detail.`}
        />,
      );

      const callout = document.querySelector(`[data-callout-type="${type}"]`);
      expect(callout).toBeInTheDocument();
      expect(callout).not.toHaveTextContent(`[!${type}]`);
      expect(callout).toHaveTextContent(`Keep this ${type.toLowerCase()} detail.`);
    },
  );

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

  it.each([
    ['formatted', '> **[!NOTE]**\n> This is ordinary text.'],
    ['escaped', '> \\[!NOTE]\n> This is ordinary text.'],
  ])('does not promote a %s marker into a callout', (_description, content) => {
    const { container } = render(<MarkdownRenderer content={content} />);

    expect(container.querySelector('[data-callout-type]')).toBeNull();
    expect(container.querySelector('blockquote')).toHaveTextContent('[!NOTE]');
  });

  it('binds a nested blockquote and a following real callout to their source positions', () => {
    const content = '> outer\n> > nested\n\n> [!WARNING]\n> Keep this warning.';
    const { container } = render(<MarkdownRenderer content={content} />);
    const blockquotes = Array.from(container.querySelectorAll('blockquote'));

    expect(blockquotes).toHaveLength(3);
    expect(blockquotes[0]).not.toHaveAttribute('data-callout-type');
    expect(blockquotes[1]).not.toHaveAttribute('data-callout-type');
    expect(blockquotes[2]).toHaveAttribute('data-callout-type', 'WARNING');
  });
});

describe('reading-surface frontmatter', () => {
  it('hides valid document-start YAML while retaining the markdown body', () => {
    const content = [
      '---',
      'tags: [history, diplomacy]',
      'unknown_field: preserved-for-round-trip',
      '---',
      '# The Ember Accord',
      '',
      'The body remains visible.',
    ].join('\n');
    const { container } = render(<MarkdownRenderer content={content} />);

    expect(container).not.toHaveTextContent('tags: [history, diplomacy]');
    expect(container).not.toHaveTextContent('unknown_field');
    expect(screen.getByRole('heading', { name: 'The Ember Accord' })).toBeInTheDocument();
    expect(container).toHaveTextContent('The body remains visible.');
  });

  it('keeps malformed document-start frontmatter visible for recovery', () => {
    const content = [
      '---',
      'status: "unterminated',
      '---',
      '# Recovery body',
    ].join('\n');
    const { container } = render(<MarkdownRenderer content={content} />);

    expect(container).toHaveTextContent('status: "unterminated');
    expect(container).toHaveTextContent('Recovery body');
  });

  it('does not treat a horizontal rule in the body as frontmatter', () => {
    const content = '# Heading\n\n---\n\nBody after the rule.';
    const { container } = render(<MarkdownRenderer content={content} />);

    expect(container).toHaveTextContent('Heading');
    expect(container).toHaveTextContent('Body after the rule.');
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

// ---------------------------------------------------------------------------

describe('T8: share-mode entry-title wikilink uses /share/:token/entries/:id', () => {
  it('generates a share-subtree href when isShareMode=true and shareToken is set', () => {

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
