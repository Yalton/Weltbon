/**
 * Issue #59 — the two-phase save in DictionaryTable.
 *
 * The rule these tests pin down: no entry body is ever written without the user
 * having seen it listed. So every case here is about whether the mutation fires
 * at all, and with which entry ids.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import type { DictionaryWord, TermRenamePreview } from '../hooks/useDictionary';

vi.mock('../hooks/useDictionary', async () => {
  const actual =
    await vi.importActual<typeof import('../hooks/useDictionary')>('../hooks/useDictionary');
  return {
    ...actual,
    useUpdateWord: vi.fn(),
    useDeleteWord: vi.fn(),
    useCreateWord: vi.fn(),
    previewTermRename: vi.fn(),
  };
});

import {
  useUpdateWord,
  useDeleteWord,
  useCreateWord,
  previewTermRename,
} from '../hooks/useDictionary';
import { DictionaryTable } from './DictionaryTable';

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

const word: DictionaryWord = {
  id: 'w1',
  universeId: 'u1',
  languageEntryId: null,
  word: 'ayin',
  ipa: '',
  partOfSpeech: 'noun',
  gloss: 'a pocket',
  etymology: '',
  tags: [],
  createdAt: '2026-06-01T00:00:00Z',
  updatedAt: '2026-06-01T00:00:00Z',
};

const preview: TermRenamePreview = {
  word: 'ayin',
  newWord: 'vaelin',
  totalOccurrences: 3,
  entries: [
    { entryId: 'e1', title: 'Field notes', wikilinkCount: 1, textCount: 1 },
    { entryId: 'e2', title: 'Geography', wikilinkCount: 1, textCount: 0 },
  ],
  skipped: [
    { entryId: 'e3', title: 'Old draft', reason: 'case_mismatch', count: 2 },
  ],
};

let mutateAsync: ReturnType<typeof vi.fn>;

const baseProps = {
  universeId: 'u1',
  data: [word],
  isPending: false,
  error: null,
  posFilter: '',
  tagFilter: '',
  editingId: 'w1',
  addingNew: false,
  lid: null,
  onEdit: vi.fn(),
  onEditDone: vi.fn(),
  onAddWord: vi.fn(),
  onSaveNew: vi.fn(),
  onDiscardNew: vi.fn(),
  onToast: vi.fn(),
};

/** Type a new spelling into the open row editor and press Save. */
function renameTo(spelling: string) {
  fireEvent.change(screen.getByLabelText('Word'), { target: { value: spelling } });
  fireEvent.click(screen.getByRole('button', { name: 'Save word' }));
}

beforeEach(() => {
  vi.clearAllMocks();
  mutateAsync = vi.fn().mockResolvedValue({ ...word, rewriteCount: 2 });
  vi.mocked(useUpdateWord).mockReturnValue({ mutateAsync, isPending: false } as never);
  vi.mocked(useDeleteWord).mockReturnValue({ mutateAsync: vi.fn(), isPending: false } as never);
  vi.mocked(useCreateWord).mockReturnValue({ mutateAsync: vi.fn(), isPending: false } as never);
  vi.mocked(previewTermRename).mockResolvedValue(preview);
});

describe('DictionaryTable — term rename propagation (#59)', () => {
  it('opens the review dialog and writes nothing until it is confirmed', async () => {
    render(<DictionaryTable {...baseProps} />, { wrapper: Wrapper });
    renameTo('vaelin');

    expect(await screen.findByText(/Rename references to/)).toBeInTheDocument();
    expect(screen.getByText('Field notes')).toBeInTheDocument();
    expect(screen.getByText('Geography')).toBeInTheDocument();
    expect(mutateAsync).not.toHaveBeenCalled();
  });

  it('sends every listed entry when the user confirms as-is', async () => {
    render(<DictionaryTable {...baseProps} />, { wrapper: Wrapper });
    renameTo('vaelin');

    fireEvent.click(await screen.findByRole('button', { name: /Rewrite 3 references/ }));

    await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(1));
    expect(mutateAsync.mock.calls[0][0]).toMatchObject({
      word: 'vaelin',
      propagate: { entryIds: ['e1', 'e2'] },
    });
  });

  it('omits an entry the user unchecked', async () => {
    render(<DictionaryTable {...baseProps} />, { wrapper: Wrapper });
    renameTo('vaelin');

    fireEvent.click(await screen.findByLabelText('Rewrite Geography'));
    fireEvent.click(screen.getByRole('button', { name: /Rewrite 2 references/ }));

    await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(1));
    expect(mutateAsync.mock.calls[0][0].propagate).toEqual({ entryIds: ['e1'] });
  });

  it('renames the term alone when the user picks "Rename term only"', async () => {
    render(<DictionaryTable {...baseProps} />, { wrapper: Wrapper });
    renameTo('vaelin');

    fireEvent.click(await screen.findByRole('button', { name: 'Rename term only' }));

    await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(1));
    expect(mutateAsync.mock.calls[0][0].propagate).toBeUndefined();
  });

  it('writes nothing when the dialog is cancelled', async () => {
    render(<DictionaryTable {...baseProps} />, { wrapper: Wrapper });
    renameTo('vaelin');

    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));

    await waitFor(() => expect(screen.queryByText(/Rename references to/)).toBeNull());
    expect(mutateAsync).not.toHaveBeenCalled();
  });

  it('shows the occurrences it refuses to touch', async () => {
    render(<DictionaryTable {...baseProps} />, { wrapper: Wrapper });
    renameTo('vaelin');

    expect(await screen.findByText('Old draft')).toBeInTheDocument();
    expect(screen.getByText(/different capitalisation/)).toBeInTheDocument();
  });

  it('saves in one step when nothing references the term', async () => {
    vi.mocked(previewTermRename).mockResolvedValue({
      ...preview,
      totalOccurrences: 0,
      entries: [],
      skipped: [],
    });
    render(<DictionaryTable {...baseProps} />, { wrapper: Wrapper });
    renameTo('vaelin');

    await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(1));
    expect(screen.queryByText(/Rename references to/)).toBeNull();
    expect(mutateAsync.mock.calls[0][0].propagate).toBeUndefined();
  });

  it('does not ask for a preview when the spelling is unchanged', async () => {
    render(<DictionaryTable {...baseProps} />, { wrapper: Wrapper });
    fireEvent.change(screen.getByLabelText('Gloss'), { target: { value: 'a deep pocket' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save word' }));

    await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(1));
    expect(previewTermRename).not.toHaveBeenCalled();
  });

  it('still saves the rename when the preview request fails', async () => {
    // A propagation preview that errors must not cost the user their edit.
    vi.mocked(previewTermRename).mockRejectedValue(new Error('offline'));
    render(<DictionaryTable {...baseProps} />, { wrapper: Wrapper });
    renameTo('vaelin');

    await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(1));
    expect(mutateAsync.mock.calls[0][0].propagate).toBeUndefined();
  });
});
