
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ApiError } from '../api/client';
import { syncErrorMessage, lastErrorMessage, SYNC_ERROR_COPY } from '../lib/syncErrorCopy';
import { SyncErrorNotice } from './SyncErrorNotice';

/** How many times `needle` occurs in the rendered text. */
function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

describe('SyncErrorNotice — the syncErrorMessage path (detail and raw disjoint)', () => {
  it('renders the coded headline and keeps the throw site message in a disclosure', () => {
    const copy = syncErrorMessage(
      new ApiError(502, { code: 'remote-unreachable' }, 'connect ECONNREFUSED 127.0.0.1:3001'),
    );

    const { container } = render(<SyncErrorNotice copy={copy} testId="n" />);

    expect(screen.getByText(SYNC_ERROR_COPY['remote-unreachable'].message)).toBeInTheDocument();
    // `raw` here is information the headline does not contain, so suppressing
    // it would lose the only machine-specific fact the user can act on.
    expect(container.textContent).toContain('connect ECONNREFUSED 127.0.0.1:3001');
    expect(container.querySelector('details')).not.toBeNull();
  });

  it('renders local-apply collision counts as detail, with no disclosure', () => {
    const copy = syncErrorMessage(
      new ApiError(409, { collisions: [{ collection: 'entries', count: 3 }] }, 'Apply blocked'),
    );

    const { container } = render(<SyncErrorNotice copy={copy} testId="n" />);

    expect(container.textContent).toContain('3 in entries');
    // That branch sets no `raw`, so there is nothing to disclose.
    expect(container.querySelector('details')).toBeNull();
  });
});

describe('SyncErrorNotice — the lastErrorMessage path (raw CONTAINS detail)', () => {
  it('shows the embedded detail exactly once, not once as detail and again as raw', () => {
    // `sync_links.last_error` shape `${code}: ${safeDetail}` — `lastErrorMessage`
    // returns detail='...' AND raw='remote-unreachable: ...', the second
    // containing the first. Rendering both prints it twice.
    const copy = lastErrorMessage('remote-unreachable: peer timed out after 30s');
    expect(copy).not.toBeNull();
    expect(copy!.raw).toContain(copy!.detail!); // the overlap this component exists for

    const { container } = render(<SyncErrorNotice copy={copy!} testId="n" />);

    expect(occurrences(container.textContent ?? '', 'peer timed out after 30s')).toBe(1);
    expect(container.querySelector('details')).toBeNull();
    // The headline still comes from the shared copy table.
    expect(screen.getByText(SYNC_ERROR_COPY['remote-unreachable'].message)).toBeInTheDocument();
  });

  it('shows the apply-error class name once', () => {
    const copy = lastErrorMessage('apply-error: CollectionCollisionError');

    const { container } = render(<SyncErrorNotice copy={copy!} testId="n" />);

    expect(occurrences(container.textContent ?? '', 'CollectionCollisionError')).toBe(1);
  });

  it('keeps the disclosure for the unexpected-error fallback, where raw is all there is', () => {
    // The bare `unexpected-error` constant carries no detail, so raw adds
    // information and must survive.
    const copy = lastErrorMessage('unexpected-error');

    const { container } = render(<SyncErrorNotice copy={copy!} testId="n" />);

    expect(copy!.detail).toBeUndefined();
    expect(container.querySelector('details')).not.toBeNull();
    expect(container.textContent).toContain('unexpected-error');
  });
});

describe('SyncErrorNotice — chrome', () => {
  it('is an alert, so a screen reader announces it without focus', () => {
    const copy = syncErrorMessage(new Error('network down'));
    render(<SyncErrorNotice copy={copy} testId="n" />);
    expect(screen.getByTestId('n')).toHaveAttribute('role', 'alert');
  });
});
