import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DocxPromoteControl } from '../DocxPromoteControl';
import type { DocxFileInfo } from '../../../types/ingestReview';

function file(overrides: Partial<DocxFileInfo['headings']> = {}): DocxFileInfo {
  return {
    path: 'chapter.docx',
    headings: { styled: 0, unstyledCandidates: 0, promoted: false, ...overrides },
    mediaCount: 0,
  };
}

describe('DocxPromoteControl (#35 DOCX-09)', () => {
  it('renders nothing when no file has unstyled candidates', () => {
    const { container } = render(
      <DocxPromoteControl files={[file()]} onPromote={vi.fn()} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing when the only candidates are already promoted', () => {
    const { container } = render(
      <DocxPromoteControl
        files={[file({ unstyledCandidates: 5, promoted: true })]}
        onPromote={vi.fn()}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('offers to promote using the server-reported count alone, regardless of styled', () => {
    // The server guarantees unstyledCandidates is 0 whenever styled > 0
    // (DOCX-09), but the client's condition must not re-derive that gate.
    // This fixture deliberately violates the invariant to prove the client
    // reads unstyledCandidates alone rather than checking styled === 0.
    render(
      <DocxPromoteControl
        files={[file({ styled: 3, unstyledCandidates: 7 })]}
        onPromote={vi.fn()}
      />,
    );
    expect(
      screen.getByRole('button', { name: /treat 7 bold paragraphs as headings/i }),
    ).toBeInTheDocument();
  });

  it('sums unstyled candidates across eligible files', () => {
    render(
      <DocxPromoteControl
        files={[
          file({ unstyledCandidates: 4 }),
          file({ unstyledCandidates: 2, promoted: true }), // excluded: already promoted
          file({ unstyledCandidates: 3 }),
        ]}
        onPromote={vi.fn()}
      />,
    );
    expect(
      screen.getByRole('button', { name: /treat 7 bold paragraphs as headings/i }),
    ).toBeInTheDocument();
  });

  it('calls onPromote when clicked', async () => {
    const onPromote = vi.fn();
    render(
      <DocxPromoteControl
        files={[file({ unstyledCandidates: 1 })]}
        onPromote={onPromote}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: /treat 1 bold paragraph as headings/i }));
    expect(onPromote).toHaveBeenCalledTimes(1);
  });

  it('disables the button while a re-request is in flight', () => {
    render(
      <DocxPromoteControl
        files={[file({ unstyledCandidates: 1 })]}
        onPromote={vi.fn()}
        disabled
      />,
    );
    expect(screen.getByRole('button')).toBeDisabled();
  });
});
