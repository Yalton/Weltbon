import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../api/client';
import { classifyError, formatBytes } from '../../lib/format';
import {
  BATCH_LIMIT_FILES,
  BATCH_LIMIT_MB,
  BATCH_LIMIT_FILE_SIZE_MB,
  BATCH_LIMIT_TOTAL_UNCOMPRESSED_MB,
  BATCH_LIMIT_DOCX_MB,
  BATCH_LIMIT_DOCX_FILES,
} from '../../lib/ingestLimits';
import type { IngestPreview } from '../../types/ingestReview';
import { ImportDropZone } from './ImportDropZone';
import { ImportProgressBar } from './ImportProgressBar';

export interface ImportUploadStepProps {
  universeId: string;
  onParsed: (preview: IngestPreview, source: UploadSource) => void;
  onCancel: () => void;
}

export type UploadKind = 'zip' | 'folder' | 'md';

export type UploadSource = { files: File[]; kind: UploadKind };

type UploadState =
  | { step: 'idle' }
  | { step: 'selected'; files: File[]; kind: UploadKind }
  | { step: 'uploading'; files: File[]; kind: UploadKind; pct: number }
  | {
      step: 'error';
      files: File[] | null;
      kind: UploadKind | null;
      message: string;
    };

const COPY_INVALID_FILE_TYPE =
  'Only .md, .markdown or .docx files, folders of them, or a .zip are accepted.';

function isMarkdown(name: string): boolean {
  const n = name.toLowerCase();
  return n.endsWith('.md') || n.endsWith('.markdown');
}

// #35 DOCX-08: a batch may mix .md/.markdown and .docx. `.docx` inside a
// `.zip` is out of scope for v1 (DOCX-08) — this only classifies the
// files[]-part upload path.
function isDocx(name: string): boolean {
  return name.toLowerCase().endsWith('.docx');
}

export function classifyAndDetectKind(
  files: File[],
):
  | { kind: UploadKind }
  | { error: string } {
  if (files.length === 0) return { error: COPY_INVALID_FILE_TYPE };
  if (files.length === 1 && files[0]!.name.toLowerCase().endsWith('.zip')) {
    return { kind: 'zip' };
  }
  for (const f of files) {
    if (!isMarkdown(f.name) && !isDocx(f.name)) return { error: COPY_INVALID_FILE_TYPE };
  }
  // Folder pick when any file has a non-empty webkitRelativePath; otherwise
  const hasRelativePath = files.some((f) => Boolean(f.webkitRelativePath));
  return { kind: hasRelativePath ? 'folder' : 'md' };
}

export function enforceBatchLimits(files: File[], kind: UploadKind): string | null {
  if (kind === 'zip') {
    if (files[0]!.size > BATCH_LIMIT_MB * 1024 * 1024) {
      return `That ZIP is too large (max ${BATCH_LIMIT_MB} MB compressed). Try splitting it.`;
    }
    return null;
  }
  // .docx caps are checked separately from, and BEFORE, the markdown per-file
  // the markdown cap or a valid multi-MB Word file gets rejected with a
  const docxFiles = files.filter((f) => isDocx(f.name));
  if (docxFiles.length > BATCH_LIMIT_DOCX_FILES) {
    return `Too many Word documents (max ${BATCH_LIMIT_DOCX_FILES}). Try splitting your upload.`;
  }
  for (const f of docxFiles) {
    if (f.size > BATCH_LIMIT_DOCX_MB * 1024 * 1024) {
      return `${f.name} is too large (max ${BATCH_LIMIT_DOCX_MB} MB for a .docx).`;
    }
  }
  if (files.length > BATCH_LIMIT_FILES) {
    return `Too many files (max ${BATCH_LIMIT_FILES}). Try splitting your upload.`;
  }
  for (const f of files) {
    if (isDocx(f.name)) continue; // markdown cap does not apply to docx parts.
    if (f.size > BATCH_LIMIT_FILE_SIZE_MB * 1024 * 1024) {
      return `One file is too large (max ${BATCH_LIMIT_FILE_SIZE_MB} MB per file).`;
    }
  }
  // Total-uncompressed cap is a server-only concern (we can't reliably
  // predict zip-expanded size client-side; for folders the per-file × count
  // pre-check has a place to land.
  void BATCH_LIMIT_TOTAL_UNCOMPRESSED_MB;
  return null;
}

function buildFormData(
  files: File[],
  kind: UploadKind,
  splitLevel?: number | null,
  promotedDocxIndices?: ReadonlySet<number>,
): FormData {
  const fd = new FormData();
  // #37 SP-04: three states on the wire. Omitted = auto-detect; the literal
  if (splitLevel !== undefined) {
    fd.append('split_level', splitLevel === null ? 'null' : String(splitLevel));
  }
  // #35 DOCX-09/DOCX-10: every selected upload index is sent as a repeated
  for (const index of [...(promotedDocxIndices ?? [])].sort(
    (a, b) => a - b,
  )) {
    fd.append('docx_promote_index', String(index));
  }
  if (kind === 'zip') {
    fd.append('zip', files[0]!);
  } else {
    for (const f of files) {
      // filename is sent and category-from-folder derivation breaks.
      const name = f.webkitRelativePath || f.name;
      fd.append('files', f, name);
    }
  }
  return fd;
}

export function requestPreview(
  universeId: string,
  files: File[],
  kind: UploadKind,
  splitLevel?: number | null,
  promotedDocxIndices?: ReadonlySet<number>,
): Promise<IngestPreview> {
  return api<IngestPreview>(`/universes/${universeId}/ingest`, {
    method: 'POST',
    body: buildFormData(files, kind, splitLevel, promotedDocxIndices),
  });
}

function describeSelection(files: File[], kind: UploadKind): string {
  if (kind === 'folder' && files[0]?.webkitRelativePath) {
    const top = files[0]!.webkitRelativePath.split('/')[0];
    if (top) return top;
  }
  return files[0]!.name;
}

// #35: a lone .docx classifies as kind='md' (DOCX-08 -- .docx joins the
export function describeKind(kind: UploadKind, files: File[]): string {
  if (kind === 'zip') return 'ZIP archive';
  if (kind === 'folder') return `Folder (${files.length} files)`;
  const docxCount = files.filter((f) => isDocx(f.name)).length;
  const mdCount = files.length - docxCount;
  if (docxCount === 0) {
    return mdCount === 1 ? '.md file' : `${mdCount} .md files`;
  }
  if (mdCount === 0) {
    return docxCount === 1 ? '.docx file' : `${docxCount} .docx files`;
  }
  return `${files.length} files (${mdCount} .md, ${docxCount} .docx)`;
}

function describeSize(files: File[]): string {
  const total = files.reduce((s, f) => s + f.size, 0);
  return formatBytes(total);
}

export function ImportUploadStep({
  universeId,
  onParsed,
  onCancel,
}: ImportUploadStepProps) {
  const [state, setState] = useState<UploadState>({ step: 'idle' });
  const timerRef = useRef<number | null>(null);

  // Effect cleanup: clear any outstanding deterministic-fill timer on unmount.
  useEffect(() => {
    return () => {
      if (timerRef.current != null) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, []);

  const handleSelect = (files: File[]) => {
    const classified = classifyAndDetectKind(files);
    if ('error' in classified) {
      setState({ step: 'error', files: null, kind: null, message: classified.error });
      return;
    }
    const limitErr = enforceBatchLimits(files, classified.kind);
    if (limitErr) {
      setState({
        step: 'error',
        files,
        kind: classified.kind,
        message: limitErr,
      });
      return;
    }
    setState({ step: 'selected', files, kind: classified.kind });
  };

  const handleRemove = () => {
    if (timerRef.current != null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    setState({ step: 'idle' });
  };

  const handleUpload = async () => {
    let files: File[] | null = null;
    let kind: UploadKind | null = null;
    if (state.step === 'selected') {
      files = state.files;
      kind = state.kind;
    } else if (state.step === 'error' && state.files && state.kind) {
      files = state.files;
      kind = state.kind;
    }
    if (!files || !kind) return;

    setState({ step: 'uploading', files, kind, pct: 0 });

    // Deterministic-fill timer — same recipe as UI-SPEC §6.6 commit progress.
    const estimatedMs = Math.max(500, files.length * 50);
    const startedAt = performance.now();
    const tick = () => {
      const elapsed = performance.now() - startedAt;
      const linearPct = Math.min(90, (elapsed / estimatedMs) * 90);
      setState((prev) =>
        prev.step === 'uploading' ? { ...prev, pct: linearPct } : prev,
      );
      if (elapsed < estimatedMs) {
        timerRef.current = window.setTimeout(tick, 50);
      }
    };
    tick();

    try {
      const preview = await requestPreview(universeId, files, kind);
      if (timerRef.current != null) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      setState({ step: 'idle' });
      onParsed(preview, { files, kind });
    } catch (err) {
      if (timerRef.current != null) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      // T-12-22: render only canned classifyError output, never raw err.message.
      setState({
        step: 'error',
        files,
        kind,
        message: classifyError(err),
      });
    }
  };

  const uploadDisabled =
    state.step !== 'selected' &&
    !(
      state.step === 'error' &&
      state.files !== null &&
      state.kind !== null &&
      state.files.length > 0
    );

  return (
    <div className="max-w-2xl mx-auto py-12">
      <h1 className="text-2xl font-semibold tracking-tight">Import notes</h1>
      <p className="mt-2 text-sm text-neutral-600 dark:text-neutral-400 leading-[1.5]">
        Upload one or more Markdown files, a folder, or a ZIP. We&apos;ll parse
        each file and let you review before anything saves.
      </p>

      {state.step === 'error' && (
        <div
          role="alert"
          className="mt-4 bg-red-600 text-white rounded-md p-3 text-sm"
        >
          {state.message}
        </div>
      )}

      {state.step === 'idle' || state.step === 'uploading' ? (
        <ImportDropZone
          onSelect={handleSelect}
          disabled={state.step === 'uploading'}
        />
      ) : state.files && state.kind ? (
        <div className="mt-6 flex items-center justify-between rounded-md border border-neutral-200 dark:border-neutral-800 px-4 py-3">
          <div className="text-sm min-w-0">
            <p className="font-semibold truncate max-w-[400px]">
              {describeSelection(state.files, state.kind)}
            </p>
            <p className="text-neutral-400">
              {describeSize(state.files)} ·{' '}
              {describeKind(state.kind, state.files)}
            </p>
          </div>
          <button
            type="button"
            onClick={handleRemove}
            className="text-sm text-neutral-400 hover:text-neutral-200"
          >
            Remove
          </button>
        </div>
      ) : null}

      {state.step === 'uploading' && (
        <ImportProgressBar
          pct={state.pct}
          done={false}
          ariaLabel="Upload progress"
        />
      )}

      <div className="mt-6 flex items-center justify-end gap-2">
        <Link
          to={`/universes/${universeId}/entries`}
          onClick={onCancel}
          className="px-3 py-1.5 text-sm rounded-md border border-neutral-300 dark:border-neutral-700"
        >
          Cancel
        </Link>
        <button
          type="button"
          onClick={handleUpload}
          disabled={uploadDisabled}
          className="bg-[color:var(--color-accent)] text-white text-sm px-3 py-1.5 rounded-md disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {state.step === 'uploading' ? 'Parsing…' : 'Upload'}
        </button>
      </div>
    </div>
  );
}
