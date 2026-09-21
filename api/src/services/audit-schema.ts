/**
 *
 * Extracted from api/src/providers/llm/openai.ts so both the OpenAI provider
 * validation of Anthropic tool_use responses) share a single canonical schema.
 *
 * Security invariant (T-24-04-03 + T-24-04-04):
 *   - `gap_key` is intentionally absent from `AuditSuggestionSchema`.
 *     The audit engine computes gap_key post-parse via computeGapKey() per
 *     AUDIT-08 / D-08. If the LLM emits gap_key, it is silently dropped in
 *     relaxed-mode parse (Zod ignores extra fields by default). Use
 *     `AuditSuggestionStrictSchema` in the engine for defense in depth —
 *     it explicitly rejects extra fields via .strict(), so a smuggled gap_key
 *     causes an immediate parse failure (LLM output is rejected wholesale).
 *   - Category enum locks out `influence-gap` (the legacy name, superseded by
 *     `dangling-thread` per AUDIT-07). Any LLM output with that category fails
 *     the parse and is rejected wholesale.
 *
 * Compile-time drift check:
 *   `satisfies readonly AuditCategory[]` on AUDIT_CATEGORIES causes a TypeScript
 *   error if any literal here drifts from the canonical AuditCategory union in
 *   `../types/audit-suggestion.ts`.
 */

import { z } from 'zod';
import type { AuditCategory } from '../types/audit-suggestion.js';

// ---------------------------------------------------------------------------
// Category taxonomy (AUDIT-07 — 5 fixed values; NO 'influence-gap')
// ---------------------------------------------------------------------------

export const AUDIT_CATEGORIES = ['underdeveloped', 'missing-link', 'contradiction', 'timeline-inconsistency', 'dangling-thread'] as const satisfies readonly AuditCategory[];

export const AuditCategorySchema = z.enum(AUDIT_CATEGORIES);

// ---------------------------------------------------------------------------
// Confidence (coarse 3-level scale per ROADMAP anti-pattern — no percentages)
// ---------------------------------------------------------------------------

export const AuditConfidenceSchema = z.enum(['high', 'medium', 'low']);

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------

export const AuditSuggestionSchema = z.object({
  category: AuditCategorySchema,
  title: z.string().min(1).max(500),
  body: z.string().min(1).max(5000),
  referenced_entry_ids: z.array(z.string().uuid()).min(1).max(20),
  confidence: AuditConfidenceSchema,
});

export const AuditSuggestionStrictSchema = AuditSuggestionSchema.strict();

// ---------------------------------------------------------------------------
// AuditOutputSchema — the top-level envelope the LLM emits
// ---------------------------------------------------------------------------

export const AuditOutputSchema = z.object({
  suggestions: z.array(AuditSuggestionSchema),
});

export const AuditOutputStrictSchema = z.object({
  suggestions: z.array(AuditSuggestionStrictSchema),
}).strict();

export type AuditSuggestionInput = z.infer<typeof AuditSuggestionSchema>;
export type AuditOutputInput = z.infer<typeof AuditOutputSchema>;
export type AuditOutputStrictInput = z.infer<typeof AuditOutputStrictSchema>;
