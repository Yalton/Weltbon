
export type AuditCategory =
  | 'underdeveloped'
  | 'missing-link'
  | 'contradiction'
  | 'timeline-inconsistency'
  | 'dangling-thread';

export interface AuditSuggestion {
  category: AuditCategory;
  entryId?: string;
  referencedEntryIds: string[];
  rationale: string;
  evidence: string;
}

export interface PersistedAuditSuggestion extends AuditSuggestion {
  id: string;
  gapKey: string;
  source: 'ai';
  model: string;
  auditRunId: string;
  dismissalSnapshot: null | {
    snapshotAt: string;
    entries: Array<{ id: string; updatedAt: string }>;
  };
}

export type DismissalReason =
  | 'intentional'
  | 'inaccurate'
  | 'not_now'
  | 'duplicate_of_human_issue';

export interface IssueApiResponse extends PersistedAuditSuggestion {
  dismissedAt: string | null;
  dismissalReason: DismissalReason | null;
  dismissalNotes: string | null;
  dismissalSnoozeRemaining: number | null;
  linkedIssueId: string | null;
  category: AuditCategory | null;
  // Response projection (resolved server-side from joined tables)
  rationale: string;           // from issues.description
  costUsd: string;             // numeric serializes as string
  consultedEntries: Array<{ id: string; title: string; icon: string; updatedAt: string }>;
  // D-03 bidirectional reverse direction — populated only on HUMAN-source rows
  linkedByAiIssueIds?: string[];
}

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------

export type AuditRunStatus = 'pending' | 'running' | 'succeeded' | 'failed';

export interface AuditEstimateBreakdown {
  basePromptTokens: number;
  ratePerMTokIn: number;
  ratePerMTokOut: number;
  ratePerMTokCachedRead: number;
  maxToolCalls: number;
  maxOutputTokens: number;
  perCallInputTokens: number;
  perCallOutputTokens: number;
  minOutputTokens: number;
  scopeEntryCount: number;
}

export interface AuditEstimate {
  lower: number;
  upper: number;
  breakdown: AuditEstimateBreakdown;
  model: { provider: 'anthropic' | 'openai' | 'ollama'; name: string };
}

export interface InFlightAuditSummary {
  id: string;
  universeId: string;
  universeName: string;
  scope: 'universe' | 'entry';
  scopeEntryId: string | null;
  scopeEntryTitle: string | null;
  status: Extract<AuditRunStatus, 'pending' | 'running'>;
  startedAt: string;
  costUsd: string;
  toolCallCount: number;
}

export interface AuditHistoryRow {
  id: string;
  scope: 'universe' | 'entry';
  scopeEntryId: string | null;
  scopeEntryTitle: string | null;
  provider: string;
  model: string;
  status: AuditRunStatus;
  costUsd: string;
  startedAt: string;
  finishedAt: string | null;
  suggestionsByCategory: Partial<Record<AuditCategory, number>>;
  analyzedEntries: number;
  totalEntries: number | null;
}
