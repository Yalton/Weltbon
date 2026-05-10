import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import type { IngestPreview } from '../../types/ingestReview';

vi.mock('../../api/client', async () => {
  const actual = await vi.importActual<typeof import('../../api/client')>(
    '../../api/client',
  );
  return { ...actual, api: vi.fn() };
});

import { api, ApiError } from '../../api/client';
import { ImportUploadStep } from './ImportUploadStep';

function makeMdFile(name: string, sizeBytes = 100, relativePath?: string): File {
  const f = new File(['x'.repeat(sizeBytes)], name, { type: 'text/markdown' });
  if (relativePath !== undefined) {
    Object.defineProperty(f, 'webkitRelativePath', {
      value: relativePath,
      configurable: true,
    });
  }
  return f;
}

function makeZipFile(name: string, sizeBytes = 1024): File {
  return new File([new Uint8Array(sizeBytes)], name, { type: 'application/zip' });
}

function fixturePreview(): IngestPreview {
  return {
    summary: {
      markdown_files_parsed: 1,
      non_markdown_files_skipped: 0,
      hidden_paths_filtered: 0,
      duplicate_titles_in_batch: 0,
      unresolved_wikilinks: 0,
    },
    entries: [],
    warnings: [],
  };
}

function renderStep(
  overrides: Partial<{
    universeId: string;
    onParsed: (p: IngestPreview) => void;
    onCancel: () => void;
  }> = {},
) {
  const onParsed = overrides.onParsed ?? vi.fn();
  const onCancel = overrides.onCancel ?? vi.fn();
  const universeId = overrides.universeId ?? 'U1';
  const result = render(
    <MemoryRouter>
      <ImportUploadStep
        universeId={universeId}
        onParsed={onParsed}
        onCancel={onCancel}
      />
    </MemoryRouter>,
  );
  return { ...result, onParsed, onCancel };
}

/**
 * Drive a file selection through ImportDropZone's hidden <input>. We use
 * fireEvent.change after defining `files` because userEvent.upload() does
 * not preserve the synthetic webkitRelativePath that we set on the File.
 */
function selectFiles(container: HTMLElement, files: File[]) {
  const input = container.querySelector(
    'input[type="file"]',
  ) as HTMLInputElement | null;
  if (!input) throw new Error('hidden file input not found');
  Object.defineProperty(input, 'files', { value: files, configurable: true });
  fireEvent.change(input);
}

describe('ImportUploadStep — idle render and interactive flows', () => {
  let originalDescriptor: PropertyDescriptor | undefined;

  beforeEach(() => {
    vi.mocked(api).mockReset();
    originalDescriptor = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'webkitdirectory',
    );
  });

  afterEach(() => {
    if (originalDescriptor === undefined) {
      // Best-effort delete; fine if jsdom never installed it.
      try {
        delete (HTMLInputElement.prototype as unknown as Record<string, unknown>)
          .webkitdirectory;
      } catch {
        /* ignore */
      }
    } else {
      Object.defineProperty(
        HTMLInputElement.prototype,
        'webkitdirectory',
        originalDescriptor,
      );
    }
  });

  it('renders the H1 "Import notes" and the helper paragraph', () => {
    renderStep();
    expect(
      screen.getByRole('heading', { name: /import notes/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        /upload a folder of markdown files or a zip\. we'll parse each file/i,
      ),
    ).toBeInTheDocument();
  });

  it('Upload button is disabled in idle state', () => {
    renderStep();
    const upload = screen.getByRole('button', { name: /upload/i });
    expect(upload).toBeDisabled();
  });

  it('shows the amber fallback notice when webkitdirectory unsupported (jsdom default)', () => {
    renderStep();
    expect(
      screen.getByText(/Folder upload works in Chrome, Edge, and Safari/i),
    ).toBeInTheDocument();
  });

  it('hides the fallback notice when webkitdirectory is supported on the prototype', () => {
    Object.defineProperty(HTMLInputElement.prototype, 'webkitdirectory', {
      configurable: true,
      writable: true,
      value: false,
    });
    renderStep();
    expect(
      screen.queryByText(/Folder upload works in Chrome/i),
    ).not.toBeInTheDocument();
  });

  it('selecting a single .md file transitions to selected and enables Upload', () => {
    const { container } = renderStep();
    selectFiles(container, [makeMdFile('note.md', 200)]);
    expect(screen.getByText('note.md')).toBeInTheDocument();
    const upload = screen.getByRole('button', { name: /upload/i });
    expect(upload).not.toBeDisabled();
  });

  it('rejects a .txt file with the §10 invalid-file-type copy and does NOT call api()', () => {
    const { container } = renderStep();
    selectFiles(container, [
      new File(['x'], 'note.txt', { type: 'text/plain' }),
    ]);
    expect(
      screen.getByRole('alert'),
    ).toHaveTextContent(/Only \.md files \(in a folder\) or a \.zip are accepted\./i);
    expect(api).not.toHaveBeenCalled();
  });

  it('rejects more than BATCH_LIMIT_FILES files client-side without calling api()', () => {
    const { container } = renderStep();
    const tooMany: File[] = [];
    for (let i = 0; i < 1001; i++) {
      tooMany.push(makeMdFile(`f${i}.md`, 10, `Vault/f${i}.md`));
    }
    selectFiles(container, tooMany);
    expect(screen.getByRole('alert')).toHaveTextContent(
      /Too many files \(max 1000\)\. Try splitting your upload\./i,
    );
    expect(api).not.toHaveBeenCalled();
  });

  it('rejects a .md file larger than BATCH_LIMIT_FILE_SIZE_MB without calling api()', () => {
    const { container } = renderStep();
    // 1.1 MB > 1 MB cap.
    const big = makeMdFile('big.md', 1024 * 1024 + 100, 'Vault/big.md');
    selectFiles(container, [big]);
    expect(screen.getByRole('alert')).toHaveTextContent(
      /One file is too large \(max 1 MB per file\)\./i,
    );
    expect(api).not.toHaveBeenCalled();
  });

  it('ZIP success path: calls api() with FormData containing a zip part and invokes onParsed', async () => {
    const preview = fixturePreview();
    vi.mocked(api).mockResolvedValueOnce(preview as unknown);
    const { container, onParsed } = renderStep();

    const zip = makeZipFile('vault.zip', 256);
    selectFiles(container, [zip]);
    const upload = screen.getByRole('button', { name: /upload/i });
    await userEvent.click(upload);

    await waitFor(() => {
      expect(onParsed).toHaveBeenCalledWith(preview);
    });

    expect(api).toHaveBeenCalledTimes(1);
    const [path, init] = vi.mocked(api).mock.calls[0]!;
    expect(path).toBe('/universes/U1/ingest');
    const fd = (init as RequestInit).body as FormData;
    expect(fd).toBeInstanceOf(FormData);
    const entries = Array.from(fd.entries());
    expect(entries).toHaveLength(1);
    expect(entries[0]![0]).toBe('zip');
  });

  it('Folder success path: appends each .md file under "files" preserving webkitRelativePath', async () => {
    const preview = fixturePreview();
    vi.mocked(api).mockResolvedValueOnce(preview as unknown);
    const { container, onParsed } = renderStep();

    const f1 = makeMdFile('a.md', 50, 'MyVault/notes/a.md');
    const f2 = makeMdFile('b.md', 50, 'MyVault/notes/b.md');
    const f3 = makeMdFile('c.md', 50, 'MyVault/c.md');
    selectFiles(container, [f1, f2, f3]);
    const upload = screen.getByRole('button', { name: /upload/i });
    await userEvent.click(upload);

    await waitFor(() => {
      expect(onParsed).toHaveBeenCalledWith(preview);
    });

    const [, init] = vi.mocked(api).mock.calls[0]!;
    const fd = (init as RequestInit).body as FormData;
    const entries = Array.from(fd.entries());
    expect(entries).toHaveLength(3);
    for (const [k] of entries) expect(k).toBe('files');
    const names = entries.map(([, v]) => (v as File).name);
    expect(names).toEqual([
      'MyVault/notes/a.md',
      'MyVault/notes/b.md',
      'MyVault/c.md',
    ]);
  });

  it('Network error: shows server-unreachable copy and re-enables Upload', async () => {
    vi.mocked(api).mockRejectedValueOnce(new TypeError('Failed to fetch'));
    const { container } = renderStep();

    selectFiles(container, [makeZipFile('vault.zip', 256)]);
    const upload = screen.getByRole('button', { name: /upload/i });
    await userEvent.click(upload);

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(
        /Couldn't reach the server\./i,
      );
    });
    // Selected-file row stays visible for retry.
    expect(screen.getByText('vault.zip')).toBeInTheDocument();
    // Upload button enabled again so user can retry.
    expect(screen.getByRole('button', { name: /upload/i })).not.toBeDisabled();
  });

  it('413 file_count error: maps to the §10 too-many-files copy', async () => {
    vi.mocked(api).mockRejectedValueOnce(
      new ApiError(
        413,
        { error: 'Batch limit exceeded', limit: 'file_count' },
        'Batch limit exceeded',
      ),
    );
    const { container } = renderStep();

    selectFiles(container, [makeZipFile('vault.zip', 256)]);
    await userEvent.click(screen.getByRole('button', { name: /upload/i }));

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(
        /Too many files \(max 1000\)\. Try splitting your upload\./i,
      );
    });
    expect(screen.getByRole('button', { name: /upload/i })).not.toBeDisabled();
  });

  it('Cancel renders as an <a href="/universes/U1/entries"> and onCancel runs on click', async () => {
    const onCancel = vi.fn();
    renderStep({ onCancel });
    const cancel = screen.getByRole('link', { name: /cancel/i });
    expect(cancel).toHaveAttribute('href', '/universes/U1/entries');
    await userEvent.click(cancel);
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('progress bar appears during upload and is removed after onParsed fires', async () => {
    let resolveApi!: (value: unknown) => void;
    vi.mocked(api).mockImplementationOnce(
      () =>
        new Promise<unknown>((resolve) => {
          resolveApi = resolve;
        }) as Promise<unknown>,
    );
    const onParsed = vi.fn();
    const { container } = renderStep({ onParsed });

    selectFiles(container, [makeZipFile('vault.zip', 256)]);
    await userEvent.click(screen.getByRole('button', { name: /upload/i }));

    await waitFor(() => {
      expect(screen.getByRole('progressbar')).toBeInTheDocument();
    });

    const preview = fixturePreview();
    await act(async () => {
      resolveApi(preview);
    });

    await waitFor(() => expect(onParsed).toHaveBeenCalledWith(preview));
    // Progress bar removed once we transition out of uploading state — the
    // success path resets state.step to 'idle' (parent typically unmounts
    // first; this exercises the state-machine fallback inside the
    // component when the parent does NOT immediately unmount).
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
  });
});
