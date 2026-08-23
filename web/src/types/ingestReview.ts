/**
 * Source-of-truth TypeScript types for the Phase 12 markdown-ingestion review
 * UI and the atomic-commit endpoint.
 *
 * Shape contracts:
 *   - IngestPreview / PreviewEntry / LinkOut: verbatim mirror of
 *     `api/src/services/ingest-markdown.ts:64-85` — what the Phase 11
 *     `POST /api/universes/:uid/ingest` endpoint returns.
 *   - CommitBody / CommitEntry: wire shape POSTed to
 *     `/api/universes/:uid/ingest/commit` (Plan 12-01 commitBodySchema).
 *   - CommitResult: response shape from the same endpoint.
 *   - ReviewDecisions / EntryEdits / CommitDecision: client-side review
 *     state, serialized to localStorage as part of SavedDraft.
 *
 * Pure-type module: no React, no runtime exports. Vite tree-shakes this to
 * nothing at build time.
 */

// ---------------------------------------------------------------------------
// Mirror of api/src/services/ingest-markdown.ts (IngestPreview shape)
// ---------------------------------------------------------------------------

export type LinkOut = {
  target: string;
  target_path?: string;
  target_id?: string;
  label: string;
  resolved: boolean;
  warning?: string;
};

export type PreviewEntry = {
  filename: string;
  path: string;
  title: string;
  type: string;
  tags: string[];
  category: string | null;
  body: string;
  meta: Record<string, unknown>;
  linksOut: LinkOut[];
  categoryIsNew?: boolean;
  titleCollision?: boolean;
};

/**
 * #37 SP-04 — split detection metadata the preview reports for a
 * single-document batch. `detected` is what the server auto-detected;
 * `applied` is what THIS preview actually used (they diverge on an override,
 * or when the user opted out with an explicit null).
 *
 * OPTIONAL because a draft saved to localStorage before #37 shipped has no
 * `split` key, and IngestImport rehydrates those drafts verbatim.
 */
export type SplitInfo = {
  eligible: boolean;
  detected: number | null;
  applied: number | null;
  /** Level -> entry count. Keys are strings because they arrive as JSON keys. */
  counts: Record<string, number>;
};

/**
 * #35 DOCX-10 — per-.docx heading-conversion report.
 *
 * `path` is the ORIGINAL uploaded name (e.g. `Chapter.DOCX`), never the
 * server's internal `.md` rewrite (DOCX-01) — a review UI that warned about
 * `chapter.md` would be talking about a file the user never uploaded.
 *
 * `unstyledCandidates` is reported POST-GATE: the server already zeroes it
 * out when the deterministic pass found styled headings, because promotion
 * only ever applies when that pass found nothing. The client must not
 * re-derive that gate (e.g. `styled === 0 && unstyledCandidates > 0`) —
 * `unstyledCandidates > 0` alone is the complete, correct condition, and
 * duplicating the rule here would drift from the server's the moment either
 * side changes it.
 */
export type DocxFileInfo = {
  /** Stable position in the original multipart upload. Paths are not unique. */
  uploadIndex: number;
  path: string;
  headings: {
    styled: number;
    unstyledCandidates: number;
    promoted: boolean;
  };
  mediaCount: number;
};

export type DocxInfo = {
  files: DocxFileInfo[];
};

export type IngestPreview = {
  summary: {
    markdown_files_parsed: number;
    non_markdown_files_skipped: number;
    hidden_paths_filtered: number;
    duplicate_titles_in_batch: number;
    unresolved_wikilinks: number;
    /**
     * #35 DOCX-10.
     *
     * Optional HERE ONLY as tolerance for a response this client did not
     * produce — an older API, a fixture, a hand-written stub. It is NOT
     * absent on a preview with no .docx parts: `ingestPreviewSchema` declares
     * it required and the handler emits it unconditionally. Do not write code
     * that reads `undefined` as "there were no .docx files" — 0 is that signal.
     */
    docx_files_converted?: number;
  };
  entries: PreviewEntry[];
  warnings: Array<{ file: string; message: string }>;
  split?: SplitInfo;
  /**
   * #35 DOCX-10. Optional on the same terms as `summary.docx_files_converted`
   * above: required in the server's schema and emitted unconditionally, so a
   * .docx-free preview arrives as `{ files: [] }` — never absent.
   */
  docx?: DocxInfo;
};

// ---------------------------------------------------------------------------
// Per-entry user decisions (review state). Indexed by entry.path.
// ---------------------------------------------------------------------------

export type CommitDecision =
  | { disposition: 'accept' }
  | { disposition: 'reject' } // client-side only; filtered before commit
  | { disposition: 'rename'; newTitle: string }
  | { disposition: 'skip' };

export type EntryEdits = {
  title?: string;
  entryType?: string;
  tags?: string[];
  category?: { existingId: string } | { newName: string } | null;
  body?: string;
  meta?: Record<string, unknown>;
};

export type ReviewDecisions = Record<
  string,
  {
    decision: CommitDecision;
    edits: EntryEdits;
    metaValid: boolean;
  }
>;

// ---------------------------------------------------------------------------
// Wire shape POSTed to /api/universes/:uid/ingest/commit
// (mirrors Plan 12-01 commitBodySchema).
// ---------------------------------------------------------------------------

export type CommitEntry = {
  filename: string;
  path: string;
  title: string;
  entryType: string;
  tags: string[];
  category: { existingId: string } | { newName: string } | null;
  body: string;
  meta: Record<string, unknown>;
  linksOut: Omit<LinkOut, 'warning'>[];
  decision:
    | { disposition: 'accept' }
    | { disposition: 'rename'; newTitle: string }
    | { disposition: 'skip' };
};

export type CommitBody = { entries: CommitEntry[] };

export type CommitResult = {
  entryIds: string[];
  linksCreated: number;
  categoriesCreated: number;
};

// ---------------------------------------------------------------------------
// localStorage draft slot (D-20). Key: `weltbon.import.${uid}`.
// ---------------------------------------------------------------------------

export type SavedDraft = {
  preview: IngestPreview;
  decisions: ReviewDecisions;
  savedAt: string; // ISO 8601
};
