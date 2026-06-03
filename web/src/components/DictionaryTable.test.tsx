/**
 * Phase 32 Plan 03 — DictionaryTable + DictionaryImportDialog smoke tests
 * (Wave 0 target file).
 *
 * Task 2: sort/filter smoke tests for DictionaryTable.
 * Task 3: DictionaryImportDialog smoke tests appended below.
 *
 * Pattern: RTL + jsdom render-smoke (mirrors AuditHistoryTable.test.tsx).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import type { DictionaryWord } from '../hooks/useDictionary';

// Per-file mocks — prevent blast radius
vi.mock('../hooks/useDictionary', async () => {
  const actual = await vi.importActual<typeof import('../hooks/useDictionary')>('../hooks/useDictionary');
  return {
    ...actual,
    useUpdateWord: vi.fn(),
    useDeleteWord: vi.fn(),
    useImportDictionaryCsv: vi.fn(),
    useCreateWord: vi.fn(),
  };
});

import { useUpdateWord, useDeleteWord, useImportDictionaryCsv, useCreateWord } from '../hooks/useDictionary';

function Wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return (
    <QueryClientProvider client={qc}>
      <MemoryRouter>{children}</MemoryRouter>
    </QueryClientProvider>
  );
}

// ─── Fixture data ─────────────────────────────────────────────────────────────

const fixtureWords: DictionaryWord[] = [
  {
    id: 'w1',
    universeId: 'u1',
    languageEntryId: null,
    word: 'mira',
    ipa: 'mi.ɾa',
    partOfSpeech: 'verb',
    gloss: 'to see',
    etymology: '',
    tags: ['common'],
    createdAt: '2026-06-01T00:00:00Z',
    updatedAt: '2026-06-01T00:00:00Z',
  },
  {
    id: 'w2',
    universeId: 'u1',
    languageEntryId: null,
    word: 'akva',
    ipa: 'ak.va',
    partOfSpeech: 'noun',
    gloss: 'water',
    etymology: '',
    tags: ['nature', 'common'],
    createdAt: '2026-06-01T00:00:00Z',
    updatedAt: '2026-06-01T00:00:00Z',
  },
  {
    id: 'w3',
    universeId: 'u1',
    languageEntryId: null,
    word: 'bela',
    ipa: 'be.la',
    partOfSpeech: 'adjective',
    gloss: 'beautiful',
    etymology: '',
    tags: ['descriptive'],
    createdAt: '2026-06-01T00:00:00Z',
    updatedAt: '2026-06-01T00:00:00Z',
  },
];

// Mock mutation return values
function setupMocks() {
  vi.mocked(useUpdateWord).mockReturnValue({
    mutateAsync: vi.fn(),
    isPending: false,
  } as never);
  vi.mocked(useDeleteWord).mockReturnValue({
    mutateAsync: vi.fn(),
    isPending: false,
  } as never);
  vi.mocked(useCreateWord).mockReturnValue({
    mutateAsync: vi.fn(),
    isPending: false,
  } as never);
}

// ─── DictionaryTable tests ────────────────────────────────────────────────────

import { DictionaryTable } from './DictionaryTable';

const baseProps = {
  universeId: 'u1',
  data: fixtureWords,
  isPending: false,
  error: null,
  posFilter: '',
  tagFilter: '',
  editingId: null,
  addingNew: false,
  lid: null,
  onEdit: vi.fn(),
  onEditDone: vi.fn(),
  onAddWord: vi.fn(),
  onSaveNew: vi.fn(),
  onDiscardNew: vi.fn(),
  onToast: vi.fn(),
};

describe('DictionaryTable — default sort (word asc)', () => {
  beforeEach(() => {
    setupMocks();
  });

  it('(a) renders rows in default word-ascending order', () => {
    render(<DictionaryTable {...baseProps} />, { wrapper: Wrapper });

    const cells = screen.getAllByRole('cell');
    // First word cell should be 'akva' (alphabetically first)
    const wordCells = cells.filter((_, i) => i % 8 === 0); // word is first column (col 0 of 8)
    // Get all text that includes our words
    const allText = document.body.textContent ?? '';
    const akvPos = allText.indexOf('akva');
    const belaPos = allText.indexOf('bela');
    const miraPos = allText.indexOf('mira');
    // Alphabetical order: akva < bela < mira
    expect(akvPos).toBeLessThan(belaPos);
    expect(belaPos).toBeLessThan(miraPos);
  });
});

describe('DictionaryTable — toggleSort', () => {
  beforeEach(() => {
    setupMocks();
  });

  it('(b) clicking Word sort header reverses order to descending', () => {
    render(<DictionaryTable {...baseProps} />, { wrapper: Wrapper });

    // Click the Word sort button to toggle to descending
    const wordSortBtn = screen.getByRole('button', { name: /word/i });
    fireEvent.click(wordSortBtn);

    const allText = document.body.textContent ?? '';
    const akvPos = allText.indexOf('akva');
    const miraPos = allText.indexOf('mira');
    // After toggle: descending = mira before akva
    expect(miraPos).toBeLessThan(akvPos);
  });
});

describe('DictionaryTable — posFilter', () => {
  beforeEach(() => {
    setupMocks();
  });

  it('(c) posFilter="noun" narrows visible rows to only noun words', () => {
    render(<DictionaryTable {...baseProps} posFilter="noun" />, {
      wrapper: Wrapper,
    });

    // 'akva' (noun) should be visible
    expect(screen.getByText('akva')).toBeInTheDocument();
    // 'mira' (verb) should not be visible
    expect(screen.queryByText('mira')).not.toBeInTheDocument();
    // 'bela' (adjective) should not be visible
    expect(screen.queryByText('bela')).not.toBeInTheDocument();
  });
});

describe('DictionaryTable — empty state', () => {
  beforeEach(() => {
    setupMocks();
  });

  it('(d) empty data renders "No words yet" EmptyState', () => {
    render(
      <DictionaryTable {...baseProps} data={[]} />,
      { wrapper: Wrapper },
    );

    expect(screen.getByText('No words yet')).toBeInTheDocument();
  });

  it('(d2) non-empty data with posFilter that matches nothing renders "No words match"', () => {
    render(
      <DictionaryTable {...baseProps} posFilter="pronoun" />,
      { wrapper: Wrapper },
    );

    expect(screen.getByText('No words match')).toBeInTheDocument();
  });
});

// ─── DictionaryImportDialog smoke tests (Task 3 extension) ───────────────────

import { DictionaryImportDialog } from './DictionaryImportDialog';

describe('DictionaryImportDialog — smoke tests', () => {
  beforeEach(() => {
    vi.mocked(useImportDictionaryCsv).mockReturnValue({
      mutateAsync: vi.fn().mockResolvedValue({
        inserted: 2,
        updated: 0,
        rowErrors: [],
      }),
      isPending: false,
    } as never);
  });

  it('renders the CSV file input when open', () => {
    render(
      <DictionaryImportDialog
        open={true}
        onOpenChange={vi.fn()}
        universeId="u1"
        lid={null}
        onImported={vi.fn()}
      />,
      { wrapper: Wrapper },
    );

    const fileInput = document.querySelector('input[type="file"][accept=".csv"]');
    expect(fileInput).not.toBeNull();
  });

  it('shows file-too-large error copy when a >5MB file is selected', async () => {
    render(
      <DictionaryImportDialog
        open={true}
        onOpenChange={vi.fn()}
        universeId="u1"
        lid={null}
        onImported={vi.fn()}
      />,
      { wrapper: Wrapper },
    );

    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
    // Simulate a large file (6MB)
    const largeFile = new File(['x'.repeat(6 * 1024 * 1024)], 'big.csv', { type: 'text/csv' });
    Object.defineProperty(largeFile, 'size', { value: 6 * 1024 * 1024 });

    fireEvent.change(fileInput, { target: { files: [largeFile] } });

    expect(
      screen.getByText('File too large. Maximum size is 5 MB.'),
    ).toBeInTheDocument();
  });

  it('renders per-row errors when the dialog receives rowErrors', async () => {
    // Render with a controlled prop to simulate showing row errors
    render(
      <DictionaryImportDialogWithErrors />,
      { wrapper: Wrapper },
    );

    expect(screen.getByText(/Row 2:/)).toBeInTheDocument();
    expect(screen.getByText(/missing required field/i)).toBeInTheDocument();
  });
});

/**
 * Test helper: a dialog wrapper that simulates the post-import row-error state.
 * We use a small wrapper so we can drive the dialog into the "result with errors"
 * state without actually hitting the API.
 */
function DictionaryImportDialogWithErrors() {
  return (
    <DictionaryImportDialog
      open={true}
      onOpenChange={vi.fn()}
      universeId="u1"
      lid={null}
      onImported={vi.fn()}
      _testRowErrors={[{ row: 2, message: 'missing required field: gloss' }]}
      _testImportResult={{ inserted: 1, updated: 0 }}
    />
  );
}
