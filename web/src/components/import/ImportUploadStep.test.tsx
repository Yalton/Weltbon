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
import {
  ImportUploadStep,
  classifyAndDetectKind,
  enforceBatchLimits,
  describeKind,
  type UploadSource,
} from './ImportUploadStep';

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
    onParsed: (p: IngestPreview, source: UploadSource) => void;
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
function selectFiles(
  container: HTMLElement,
  files: File[],
  picker: 'Choose files' | 'Choose folder' | 'Choose ZIP' =
    'Choose files',
) {
  const input = container.querySelector(
    `input[type="file"][aria-label="${picker}"]`,
  ) as HTMLInputElement | null;
  if (!input) throw new Error(`${picker} input not found`);
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
        /upload markdown, text or word files, a folder, or a zip\. we'll parse each file/i,
      ),
    ).toBeInTheDocument();
  });

  it('Upload button is disabled in idle state', () => {
    renderStep();
    const upload = screen.getByRole('button', { name: /upload/i });
    expect(upload).toBeDisabled();
  });

  it('offers separate Markdown file, folder, and ZIP selectors', () => {
    renderStep();

    expect(
      screen.getByRole('button', { name: 'Choose files' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Choose folder' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Choose ZIP' }),
    ).toBeInTheDocument();
  });

  it('keeps directory selection off the standalone Markdown file input', () => {
    Object.defineProperty(HTMLInputElement.prototype, 'webkitdirectory', {
      configurable: true,
      writable: true,
      value: false,
    });
    renderStep();

    const markdownInput = screen.getByLabelText('Choose files');
    const folderInput = screen.getByLabelText('Choose folder');
    expect(markdownInput).not.toHaveAttribute('webkitdirectory');
    expect(markdownInput).toHaveAttribute('multiple');
    expect(folderInput).toHaveAttribute('webkitdirectory');
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

  it('accepts a .txt file for upload', () => {
    const { container } = renderStep();
    selectFiles(container, [
      new File(['x'], 'note.txt', { type: 'text/plain' }),
    ]);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByText('note.txt')).toBeInTheDocument();
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
    selectFiles(container, [zip], 'Choose ZIP');
    const upload = screen.getByRole('button', { name: /upload/i });
    await userEvent.click(upload);

    // #37: the source travels up with the preview so the reviewer can
    // re-request it at another split level.
    await waitFor(() => {
      expect(onParsed).toHaveBeenCalledWith(preview, {
        files: [zip],
        kind: 'zip',
      });
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
    selectFiles(container, [f1, f2, f3], 'Choose folder');
    const upload = screen.getByRole('button', { name: /upload/i });
    await userEvent.click(upload);

    await waitFor(() => {
      expect(onParsed).toHaveBeenCalledWith(preview, {
        files: [f1, f2, f3],
        kind: 'folder',
      });
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

    selectFiles(container, [makeZipFile('vault.zip', 256)], 'Choose ZIP');
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

    selectFiles(container, [makeZipFile('vault.zip', 256)], 'Choose ZIP');
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

    selectFiles(container, [makeZipFile('vault.zip', 256)], 'Choose ZIP');
    await userEvent.click(screen.getByRole('button', { name: /upload/i }));

    await waitFor(() => {
      expect(screen.getByRole('progressbar')).toBeInTheDocument();
    });

    const preview = fixturePreview();
    await act(async () => {
      resolveApi(preview);
    });

    await waitFor(() =>
      expect(onParsed).toHaveBeenCalledWith(preview, expect.any(Object)),
    );
    // Progress bar removed once we transition out of uploading state — the
    // success path resets state.step to 'idle' (parent typically unmounts
    // first; this exercises the state-machine fallback inside the
    // component when the parent does NOT immediately unmount).
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
  });
});

describe('.docx classification (#35)', () => {
  const docx = (name: string, bytes = 1024) =>
    new File([new Uint8Array(bytes)], name, {
      type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    });
  const md = (name: string) => new File(['# x'], name, { type: 'text/markdown' });

  it('classifies a lone .docx as a file upload, not an error', () => {
    expect(classifyAndDetectKind([docx('vale.docx')])).toEqual({ kind: 'md' });
  });

  it('accepts a mixed .md + .docx batch', () => {
    expect(classifyAndDetectKind([md('a.md'), docx('b.docx')])).toEqual({ kind: 'md' });
  });

  it('accepts .markdown alongside .docx', () => {
    // The server accepts .markdown as of DOCX-13; the client always claimed to.
    expect(classifyAndDetectKind([md('a.markdown'), docx('b.docx')])).toEqual({ kind: 'md' });
    expect(classifyAndDetectKind([md('notes.txt')])).toEqual({ kind: 'md' });
  });

  it('still rejects an unrelated extension', () => {
    expect(classifyAndDetectKind([docx('a.docx'), md('b.pdf')]))
      .toHaveProperty('error');
  });

  it('rejects a .docx over the size cap with an actionable message', () => {
    const err = enforceBatchLimits([docx('huge.docx', 26 * 1024 * 1024)], 'md');
    expect(err).toContain('25');
    expect(err).toContain('.docx');
  });

  it('rejects more than the docx count cap', () => {
    const many = Array.from({ length: 51 }, (_, i) => docx(`f${i}.docx`));
    expect(enforceBatchLimits(many, 'md')).toContain('50');
  });

  it('does not apply the .docx size cap to markdown files', () => {
    // The two caps are different by two orders of magnitude; applying the
    // wrong one to the wrong file type would reject valid uploads.
    expect(enforceBatchLimits([md('small.md')], 'md')).toBeNull();
  });

  it('does not apply the markdown 1 MB cap to a valid multi-MB .docx', () => {
    // The inverse of the previous test, and the one that actually catches
    // the cross-wiring the brief warns about: a 2 MB .docx is comfortably
    // under the 25 MB docx cap but well over the 1 MB markdown cap. If the
    // per-file markdown loop ever stops skipping docx parts, this file gets
    // rejected with a message about the wrong format even though it is
    // entirely valid. A test that only exercises a 26 MB docx (over BOTH
    // caps) cannot tell these two code paths apart — this one can.
    const twoMb = docx('report.docx', 2 * 1024 * 1024);
    expect(enforceBatchLimits([twoMb], 'md')).toBeNull();
  });

  it('applies each cap independently within one mixed batch', () => {
    // .md must be rejected for the MARKDOWN reason, not silently accepted
    // because the docx part passed its own (much larger) cap, and not
    // rejected with the docx message either -- the two caps are independent
    // and per-file, not batch-wide or cross-applied.
    const validDocx = docx('report.docx', 2 * 1024 * 1024); // under 25 MB docx cap
    const oversizedMd = md('huge.md');
    Object.defineProperty(oversizedMd, 'size', {
      value: 2 * 1024 * 1024, // over the 1 MB markdown cap
      configurable: true,
    });
    const err = enforceBatchLimits([validDocx, oversizedMd], 'md');
    expect(err).toContain('1 MB per file');
    expect(err).not.toContain('.docx');
  });

  describe('describeKind summary copy', () => {
    it('describes an all-markdown selection as before', () => {
      expect(describeKind('md', [md('a.md'), md('b.md')])).toBe('2 .md files');
      expect(describeKind('md', [md('a.md')])).toBe('.md file');
    });

    it('describes a lone .docx as a .docx file, not a .md file', () => {
      expect(describeKind('md', [docx('vale.docx')])).toBe('.docx file');
    });

    it('describes multiple .docx files as N .docx files', () => {
      expect(describeKind('md', [docx('a.docx'), docx('b.docx')])).toBe(
        '2 .docx files',
      );
    });

    it('describes a mixed batch honestly rather than lying about the format', () => {
      expect(
        describeKind('md', [md('a.md'), docx('b.docx'), docx('c.docx')]),
      ).toBe('3 files (1 .md, 2 .docx)');
    });

    it('renders the .docx summary copy in the selected-file card', () => {
      const { container } = renderStep();
      selectFiles(container, [docx('vale.docx')]);
      expect(screen.getByText('vale.docx')).toBeInTheDocument();
      expect(screen.getByText(/\.docx file/)).toBeInTheDocument();
      expect(screen.queryByText(/\.md file/)).not.toBeInTheDocument();
    });
  });
});
