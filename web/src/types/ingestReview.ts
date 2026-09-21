
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

export type SplitInfo = {
  eligible: boolean;
  detected: number | null;
  applied: number | null;
  counts: Record<string, number>;
};

export type DocxFileInfo = {
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
    docx_files_converted?: number;
  };
  entries: PreviewEntry[];
  warnings: Array<{ file: string; message: string }>;
  split?: SplitInfo;
  docx?: DocxInfo;
};

// ---------------------------------------------------------------------------
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
