import { describe, it, expect } from 'vitest';
import { classifyError } from '../lib/format';
import { ApiError } from '../api/client';

// These tests lock the two operator-visible banner strings from 16-HUMAN-UAT.md
// Tests 2 and 3. They reconstruct the banner concatenation pattern in
// IngestImport.tsx:491 — `Import failed. ${classifyError(err)} Your review is saved — try again or adjust and re-commit.`
//
// If IngestImport.tsx:491 ever changes (e.g., banner template restructure
// explicitly deferred per Phase 16.1 CONTEXT.md), this test must be
// updated in lockstep. The PHRASE content is locked by Phase 16's
// classifyError test suite (web/src/lib/format.test.ts); this file locks
// the OUTER CONCATENATION contract.
//
// Approach A (pure-string assertion) — see 16.1-BANNER-FEASIBILITY.md for why
// this approach was chosen over DOM mounting IngestImport.tsx.

function makeBanner(err: unknown): string {
  return `Import failed. ${classifyError(err)} Your review is saved — try again or adjust and re-commit.`;
}

describe('IngestImport banner (matches IngestImport.tsx:491 concatenation)', () => {
  it('title-collision error renders the locked title banner', () => {
    const err = new ApiError(409, { error: 'title still collides' }, 'title still collides');
    expect(makeBanner(err)).toBe(
      'Import failed. One or more entry titles are already in use in this universe. Rename the conflicting entries in your review and re-commit. Your review is saved — try again or adjust and re-commit.'
    );
  });

  it('category-unresolved error renders the locked category banner', () => {
    const err = new ApiError(400, { error: 'Invalid category id' }, 'Invalid category id');
    expect(makeBanner(err)).toBe(
      'Import failed. A category you selected was removed or renamed since you opened the review. Refresh the review and re-pick categories. Your review is saved — try again or adjust and re-commit.'
    );
  });
});
