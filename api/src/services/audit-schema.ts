/**
 * Phase 24 AUDIT-07 — Shared Zod schema for LLM-emitted audit suggestions.
 *
 * Extracted from api/src/providers/llm/openai.ts so both the OpenAI provider
 * (structured output via zodResponseFormat) and the audit engine (Plan 04
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

/**
 * The five canonical audit categories. Order matches AUDIT-07 spec.
 *
 * T-24-04-04 mitigation: only these exact five literals are accepted.
 * `influence-gap` is the legacy name (pre-AUDIT-07) and must NOT appear here.
 */
export const AUDIT_CATEGORIES = ['underdeveloped', 'missing-link', 'contradiction', 'timeline-inconsistency', 'dangling-thread'] as const satisfies readonly AuditCategory[];

export const AuditCategorySchema = z.enum(AUDIT_CATEGORIES);

// ---------------------------------------------------------------------------
// Confidence (coarse 3-level scale per ROADMAP anti-pattern — no percentages)
// ---------------------------------------------------------------------------

export const AuditConfidenceSchema = z.enum(['high', 'medium', 'low']);

// ---------------------------------------------------------------------------
// AuditSuggestionSchema — the shape the LLM must emit for each suggestion
// ---------------------------------------------------------------------------

/**
 * Zod schema for a single LLM-emitted suggestion.
 *
 * Fields required by the engine:
 *   - category: one of the 5 taxonomy values (T-24-04-04)
 *   - title: 1–500 chars; used by computeGapKey() as the deduplicated gap title
 *   - body: 1–5000 chars; rationale / evidence text for the user
 *   - referenced_entry_ids: 1–20 UUIDs; validated by AUDIT-09 against universe
 *   - confidence: coarse 3-level scale
 *
 * OMITTED by design (T-24-04-03):
 *   - gap_key: engine computes this post-parse via computeGapKey() (D-08).
 *     LLM cannot emit one. In relaxed mode, a smuggled gap_key is silently
 *     dropped. In strict mode (AuditSuggestionStrictSchema), it causes a
 *     parse failure and the suggestion is rejected wholesale.
 */
export const AuditSuggestionSchema = z.object({
  category: AuditCategorySchema,
  title: z.string().min(1).max(500),
  body: z.string().min(1).max(5000),
  referenced_entry_ids: z.array(z.string().uuid()).min(1).max(20),
  confidence: AuditConfidenceSchema,
});

/**
 * Strict variant — rejects any extra fields the LLM emits (e.g., a smuggled
 * `gap_key`). Used by the engine (Plan 04 Task 2) for defense in depth.
 * Parse failure here causes the suggestion to be rejected wholesale.
 */
export const AuditSuggestionStrictSchema = AuditSuggestionSchema.strict();

// ---------------------------------------------------------------------------
// AuditOutputSchema — the top-level envelope the LLM emits
// ---------------------------------------------------------------------------

/**
 * Top-level Zod schema for the complete LLM audit response.
 *
 * The LLM emits a single JSON object `{ suggestions: [...] }`.
 * The engine Zod-parses against this schema; on failure the entire output
 * is rejected (status='failed', error='invalid_output').
 */
export const AuditOutputSchema = z.object({
  suggestions: z.array(AuditSuggestionSchema),
});

// Inferred types for downstream consumers
export type AuditSuggestionInput = z.infer<typeof AuditSuggestionSchema>;
export type AuditOutputInput = z.infer<typeof AuditOutputSchema>;
