import { describe, it, expect } from 'vitest';
import { formatBytes, classifyError, pluralize } from './format';
import { ApiError } from '../api/client';

describe('formatBytes', () => {
  it('formats 0 bytes as "0 B"', () => {
    expect(formatBytes(0)).toBe('0 B');
  });

  it('formats sub-KB byte values with the B suffix', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1023)).toBe('1023 B');
  });

  it('formats KB values with one decimal', () => {
    expect(formatBytes(1024)).toBe('1.0 KB');
    expect(formatBytes(5120)).toBe('5.0 KB');
  });

  it('formats MB values with one decimal', () => {
    expect(formatBytes(1024 * 1024)).toBe('1.0 MB');
    expect(formatBytes(10 * 1024 * 1024)).toBe('10.0 MB');
  });
});

describe('classifyError — legacy JSON-import branches (preserved)', () => {
  it('matches "version" → incompatible-version copy', () => {
    const err = new ApiError(400, { error: 'Wrong version' }, 'Wrong version');
    expect(classifyError(err)).toBe(
      'This file was created with an incompatible version of Weltbon. Export from a matching version and try again.',
    );
  });

  it('matches "invalid"/"format"/"parse" → not-a-valid-export copy', () => {
    expect(
      classifyError(new ApiError(400, { error: 'invalid markdown' }, 'invalid markdown')),
    ).toBe('This file is not a valid Weltbon export. Check the file and try again.');
    expect(
      classifyError(new ApiError(400, { error: 'bad format' }, 'bad format')),
    ).toBe('This file is not a valid Weltbon export. Check the file and try again.');
    expect(
      classifyError(new ApiError(400, { error: 'failed to parse' }, 'failed to parse')),
    ).toBe('This file is not a valid Weltbon export. Check the file and try again.');
  });

  it('legacy text-match wins over status code (500 with "invalid" returns legacy copy, not DB-rejection)', () => {
    const err = new ApiError(500, { error: 'invalid markdown' }, 'invalid markdown');
    expect(classifyError(err)).toBe(
      'This file is not a valid Weltbon export. Check the file and try again.',
    );
  });

  it('SyntaxError → not-a-valid-export copy', () => {
    expect(classifyError(new SyntaxError('Unexpected token'))).toBe(
      'This file is not a valid Weltbon export. Check the file and try again.',
    );
  });
});

describe('classifyError — Phase 12 status-code branches', () => {
  it('403 → permission-denied copy', () => {
    const err = new ApiError(403, { error: 'forbidden' }, 'forbidden');
    expect(classifyError(err)).toBe(
      "You don't have permission to import to this universe.",
    );
  });

  it('409 → category-resolve copy', () => {
    const err = new ApiError(409, { error: 'category conflict' }, 'category conflict');
    expect(classifyError(err)).toBe(
      'Could not resolve a category name. Pick existing categories for any new ones.',
    );
  });

  it('413 with upload-time keys → upload-too-large copy', () => {
    expect(
      classifyError(new ApiError(413, { error: 'zip_size exceeded' }, 'zip_size exceeded')),
    ).toBe(
      'That batch exceeds the limit. Split it into smaller folders or remove some files and try again.',
    );
    expect(
      classifyError(new ApiError(413, { error: 'file_count too high' }, 'file_count too high')),
    ).toBe(
      'That batch exceeds the limit. Split it into smaller folders or remove some files and try again.',
    );
    expect(
      classifyError(
        new ApiError(413, { error: 'total_uncompressed_size exceeded' }, 'total_uncompressed_size exceeded'),
      ),
    ).toBe(
      'That batch exceeds the limit. Split it into smaller folders or remove some files and try again.',
    );
    expect(
      classifyError(new ApiError(413, { error: 'file_size too large' }, 'file_size too large')),
    ).toBe(
      'That batch exceeds the limit. Split it into smaller folders or remove some files and try again.',
    );
  });

  it('413 with commit_size key → commit-too-large copy', () => {
    const err = new ApiError(413, { error: 'commit_size exceeded' }, 'commit_size exceeded');
    expect(classifyError(err)).toBe(
      'The reviewed batch is too large to commit in one transaction. Split it across multiple imports.',
    );
  });

  it('413 fallback (unknown limit key) → commit-too-large copy', () => {
    const err = new ApiError(413, { error: 'too big' }, 'too big');
    expect(classifyError(err)).toBe(
      'The reviewed batch is too large to commit in one transaction. Split it across multiple imports.',
    );
  });

  it('500+ → DB-rejected copy', () => {
    const err = new ApiError(500, { error: 'transaction rolled back' }, 'transaction rolled back');
    expect(classifyError(err)).toBe(
      'The database rejected the import — no changes were saved. Try again, or remove a problematic entry and retry.',
    );
    const err503 = new ApiError(503, { error: 'unavailable' }, 'unavailable');
    expect(classifyError(err503)).toBe(
      'The database rejected the import — no changes were saved. Try again, or remove a problematic entry and retry.',
    );
  });

  it('non-matching ApiError below 500 returns the server message verbatim', () => {
    const err = new ApiError(400, { error: 'something else' }, 'something else');
    expect(classifyError(err)).toBe('something else');
  });

  it('network / unknown (non-ApiError, non-SyntaxError) → server-unreachable copy', () => {
    expect(classifyError(new TypeError('Failed to fetch'))).toBe(
      "Couldn't reach the server. Your review is saved locally. Try again.",
    );
    expect(classifyError(null)).toBe(
      "Couldn't reach the server. Your review is saved locally. Try again.",
    );
  });
});

describe('classifyError — Phase 12-05 parse-time 413/limit branches', () => {
  it('413 with limit="file_count" → too-many-files copy', () => {
    const err = new ApiError(
      413,
      { error: 'Batch limit exceeded', limit: 'file_count' },
      'Batch limit exceeded',
    );
    expect(classifyError(err)).toBe(
      'Too many files (max 1000). Try splitting your upload.',
    );
  });

  it('413 with limit="file_size" → per-file-too-large copy', () => {
    const err = new ApiError(
      413,
      { error: 'Batch limit exceeded', limit: 'file_size' },
      'Batch limit exceeded',
    );
    expect(classifyError(err)).toBe(
      'One file is too large (max 1 MB per file).',
    );
  });

  it('413 with limit="zip_size" → zip-too-large copy', () => {
    const err = new ApiError(
      413,
      { error: 'Batch limit exceeded', limit: 'zip_size' },
      'Batch limit exceeded',
    );
    expect(classifyError(err)).toBe(
      'That ZIP is too large (max 50 MB compressed). Try splitting it.',
    );
  });

  it('413 with limit="total_uncompressed_size" → unzipped-too-large copy', () => {
    const err = new ApiError(
      413,
      { error: 'Batch limit exceeded', limit: 'total_uncompressed_size' },
      'Batch limit exceeded',
    );
    expect(classifyError(err)).toBe(
      'That ZIP would expand beyond 100 MB after unzipping.',
    );
  });
});

describe('pluralize', () => {
  it('returns "1 entry" for n === 1', () => {
    expect(pluralize(1, 'entry', 'entries')).toBe('1 entry');
  });

  it('returns plural form for n === 0', () => {
    expect(pluralize(0, 'entry', 'entries')).toBe('0 entries');
  });

  it('returns plural form for n === 2 and n === 100', () => {
    expect(pluralize(2, 'entry', 'entries')).toBe('2 entries');
    expect(pluralize(100, 'entry', 'entries')).toBe('100 entries');
  });

  it('defaults plural to singular + "s" when omitted', () => {
    expect(pluralize(1, 'link')).toBe('1 link');
    expect(pluralize(2, 'link')).toBe('2 links');
    expect(pluralize(0, 'link')).toBe('0 links');
  });
});
