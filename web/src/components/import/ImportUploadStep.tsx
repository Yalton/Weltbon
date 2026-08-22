import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../api/client';
import { classifyError, formatBytes } from '../../lib/format';
import {
  BATCH_LIMIT_FILES,
  BATCH_LIMIT_MB,
  BATCH_LIMIT_FILE_SIZE_MB,
  BATCH_LIMIT_TOTAL_UNCOMPRESSED_MB,
} from '../../lib/ingestLimits';
import type { IngestPreview } from '../../types/ingestReview';
import { ImportDropZone } from './ImportDropZone';
import { ImportProgressBar } from './ImportProgressBar';

/**
 * Phase 12 ingest flow — first step at /universes/:uid/import.
 *
 * Owns a 4-state internal state machine (idle | selected | uploading |
 * error) and on 200 calls back the parsed IngestPreview to the parent.
 * The parent owns review-state persistence (D-20: NO localStorage write
 * here) and any transitions into review/commit/success.
 *
 * Three responsibilities:
 *   1. Upload state machine (idle | selected | uploading | error).
 *   2. Defense-in-depth batch-limit pre-check using BATCH_LIMIT_* constants
 *      from web/src/lib/ingestLimits.ts (file count, per-file size, ZIP
 *      size). Pre-check rejection never issues a network request.
 *   3. Multipart POST to /api/universes/:uid/ingest using the FormData-aware
 *      api() helper from Plan 12-02. Folder uploads append each file as
 *      `('files', f, f.webkitRelativePath || f.name)` so the Phase 11 parser
 *      can derive categories from folder structure (ING-02).
 */
export interface ImportUploadStepProps {
  universeId: string;
  /**
   * #37: the SOURCE is handed up alongside the preview because the review
   * screen can re-request the preview at a different split level, and the
   * files only ever live here — this component unmounts as soon as review
   * takes over. Without the source the reviewer would have nothing to re-POST.
   */
  onParsed: (preview: IngestPreview, source: UploadSource) => void;
  onCancel: () => void;
}

export type UploadKind = 'zip' | 'folder' | 'md';

/** The upload as posted, retained so the preview can be re-requested (#37). */
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
  'Only .md or .markdown files, folders of Markdown files, or a .zip are accepted.';

function isMarkdown(name: string): boolean {
  const n = name.toLowerCase();
  return n.endsWith('.md') || n.endsWith('.markdown');
}

function classifyAndDetectKind(
  files: File[],
):
  | { kind: UploadKind }
  | { error: string } {
  if (files.length === 0) return { error: COPY_INVALID_FILE_TYPE };
  // Single .zip → kind=zip.
  if (files.length === 1 && files[0]!.name.toLowerCase().endsWith('.zip')) {
    return { kind: 'zip' };
  }
  // All files must be markdown.
  for (const f of files) {
    if (!isMarkdown(f.name)) return { error: COPY_INVALID_FILE_TYPE };
  }
  // Folder pick when any file has a non-empty webkitRelativePath; otherwise
  // bare .md drop(s).
  const hasRelativePath = files.some((f) => Boolean(f.webkitRelativePath));
  return { kind: hasRelativePath ? 'folder' : 'md' };
}

function enforceBatchLimits(files: File[], kind: UploadKind): string | null {
  if (kind === 'zip') {
    if (files[0]!.size > BATCH_LIMIT_MB * 1024 * 1024) {
      return `That ZIP is too large (max ${BATCH_LIMIT_MB} MB compressed). Try splitting it.`;
    }
    return null;
  }
  // folder | md
  if (files.length > BATCH_LIMIT_FILES) {
    return `Too many files (max ${BATCH_LIMIT_FILES}). Try splitting your upload.`;
  }
  for (const f of files) {
    if (f.size > BATCH_LIMIT_FILE_SIZE_MB * 1024 * 1024) {
      return `One file is too large (max ${BATCH_LIMIT_FILE_SIZE_MB} MB per file).`;
    }
  }
  // Total-uncompressed cap is a server-only concern (we can't reliably
  // predict zip-expanded size client-side; for folders the per-file × count
  // caps already bound it). The constant is referenced here so a future
  // pre-check has a place to land.
  void BATCH_LIMIT_TOTAL_UNCOMPRESSED_MB;
  return null;
}

function buildFormData(
  files: File[],
  kind: UploadKind,
  splitLevel?: number | null,
): FormData {
  const fd = new FormData();
  // #37 SP-04: three states on the wire. Omitted = auto-detect; the literal
  // string "null" = do not split; "1".."6" = an explicit override. Multipart
  // carries text, so the level is stringified rather than sent as JSON.
  if (splitLevel !== undefined) {
    fd.append('split_level', splitLevel === null ? 'null' : String(splitLevel));
  }
  if (kind === 'zip') {
    fd.append('zip', files[0]!);
  } else {
    for (const f of files) {
      // The third arg preserves the relative path so the server can derive
      // folder structure (Phase 11 ING-02). Without it, only the bare
      // filename is sent and category-from-folder derivation breaks.
      const name = f.webkitRelativePath || f.name;
      fd.append('files', f, name);
    }
  }
  return fd;
}

/**
 * The ONE preview request path (#37). Both the first upload and the reviewer's
 * split-level re-request go through here, so the multipart contract — the
 * relative-path third argument, the zip part, the split_level encoding — has a
 * single definition rather than a copy per call site.
 */
export function requestPreview(
  universeId: string,
  files: File[],
  kind: UploadKind,
  splitLevel?: number | null,
): Promise<IngestPreview> {
  return api<IngestPreview>(`/universes/${universeId}/ingest`, {
    method: 'POST',
    body: buildFormData(files, kind, splitLevel),
  });
}

function describeSelection(files: File[], kind: UploadKind): string {
  if (kind === 'folder' && files[0]?.webkitRelativePath) {
    const top = files[0]!.webkitRelativePath.split('/')[0];
    if (top) return top;
  }
  return files[0]!.name;
}

function describeKind(kind: UploadKind, n: number): string {
  if (kind === 'zip') return 'ZIP archive';
  if (kind === 'folder') return `Folder (${n} files)`;
  return n === 1 ? '.md file' : `${n} .md files`;
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
    // 50 ms per file baseline, capped at 90 % until response arrives.
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
      // Reset to idle as a defensive fallback. The parent's onParsed
      // typically transitions to a new view (component unmounts), but if
      // it does not, we land in a clean idle state without the progress
      // bar lingering.
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
              {describeKind(state.kind, state.files.length)}
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
