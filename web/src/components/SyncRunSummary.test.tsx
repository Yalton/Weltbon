
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { SyncRunSummary } from './SyncRunSummary';
import type { SyncRunResult } from '../hooks/useSyncLinks';

const RESULT: SyncRunResult = {
  linkId: 'l1',
  bootstrapped: false,
  conflicts: 0,
  blobsPushed: 0,
  blobsPulled: 0,
  assetsRepairedLocally: 0,
  assetsRepairedOnPeer: 0,
  assetsSweptOnPeer: 0,
  assetsUnrepairable: 0,
  pushed: { upserted: {}, deleted: {} },
  appliedLocally: { upserted: {}, deleted: {} },
};

function renderSummary(over: Partial<SyncRunResult> = {}) {
  render(<SyncRunSummary result={{ ...RESULT, ...over }} testId="summary" />);
  return screen.getByTestId('summary');
}

describe('SyncRunSummary — assetsRepairedLocally is never a figure', () => {
  it('reports the repair without quantifying it', () => {
    // The counter counts PLANNED restores and is known to undercount, so any
    // exact number would be one the user could disprove by counting files.
    const box = renderSummary({ assetsRepairedLocally: 7 });

    expect(box).toHaveTextContent(/restored/i);
    expect(box).not.toHaveTextContent('7');
  });

  it('renders no digit at all in the repaired-locally sentence', () => {
    // Stronger than the `7` check above, which a template like "restored 12
    // files" would survive whenever the count happened not to contain a 7.
    renderSummary({ assetsRepairedLocally: 12 });

    const sentence = screen.getByText(/were restored from the remote instance/i);
    expect(sentence.textContent).not.toMatch(/\d/);
  });

  it('says nothing about local repairs when there were none', () => {
    const box = renderSummary({ assetsRepairedLocally: 0 });

    expect(box).not.toHaveTextContent(/restored from the remote instance/i);
  });
});

describe('SyncRunSummary — assetsUnrepairable is stated with its count', () => {
  it.each([
    [1, /1 asset file could not be restored/i],
    [2, /2 asset files could not be restored/i],
    [37, /37 asset files could not be restored/i],
  ])('states %i unrecoverable files by number', (n, expected) => {
    // The NUMBER, not merely the fact: "some files" leaves the user unable to
    // tell one lost file from two hundred.
    expect(renderSummary({ assetsUnrepairable: n })).toHaveTextContent(expected);
  });

  it('frames it as a warning on a run that SUCCEEDED', () => {
    const box = renderSummary({ assetsUnrepairable: 2 });

    // The success headline is still there — this is not a failure notice.
    expect(box).toHaveTextContent(/sync complete/i);
    expect(box).toHaveTextContent(/everything else synced/i);
    expect(box).toHaveAttribute('role', 'status');
  });

  it('says nothing about unrecoverable files when there are none', () => {
    // Apostrophe-free phrase on purpose: this component renders typographic
    // apostrophes, so a straight-quoted regex could never match and the
    // assertion would hold no matter what was rendered.
    const box = renderSummary({ assetsUnrepairable: 0 });

    expect(box).not.toHaveTextContent(/could not be restored/i);
  });
});

describe('SyncRunSummary — thumbSizeBytes is never shown', () => {
  it('ignores a thumbSizeBytes the server may still be sending', () => {
    // It is no longer comparable across instances, so rendering it would
    // invite a false conclusion from a real number. Passed here as an excess
    // property a wire payload could carry.
    const box = renderSummary({ thumbSizeBytes: 918273 } as Partial<SyncRunResult>);

    expect(box).not.toHaveTextContent('918273');
    expect(box.textContent ?? '').not.toMatch(/thumb/i);
  });
});

describe('SyncRunSummary — what the run did', () => {
  it('names a first sync as such', () => {
    expect(renderSummary({ bootstrapped: true })).toHaveTextContent(
      /first sync complete/i,
    );
  });

  it('says plainly when nothing had changed', () => {
    expect(renderSummary()).toHaveTextContent(/nothing had changed on either side/i);
  });

  it('totals row counts across every collection in both directions', () => {
    const box = renderSummary({
      pushed: { upserted: { entries: 2, links: 1 }, deleted: { entries: 1 } },
      appliedLocally: { upserted: { entries: 3 }, deleted: {} },
    });

    expect(box).toHaveTextContent(/sent 4 changes, applied 3 changes here/i);
  });

  it('counts blobs in both directions as transferred files', () => {
    expect(renderSummary({ blobsPushed: 2, blobsPulled: 3 })).toHaveTextContent(
      /transferred 5 files \(2 out, 3 in\)/i,
    );
  });

  it('reports recorded conflicts', () => {
    expect(renderSummary({ conflicts: 2 })).toHaveTextContent(/2 conflicts were recorded/i);
  });
});
