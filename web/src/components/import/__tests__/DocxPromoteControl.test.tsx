import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DocxPromoteControl } from '../DocxPromoteControl';
import type { DocxFileInfo } from '../../../types/ingestReview';

function file(
  uploadIndex: number,
  path: string,
  overrides: Partial<DocxFileInfo['headings']> = {},
): DocxFileInfo {
  return {
    uploadIndex,
    path,
    headings: {
      styled: 0,
      unstyledCandidates: 0,
      promoted: false,
      ...overrides,
    },
    mediaCount: 0,
  };
}

describe('DocxPromoteControl (#35 DOCX-09)', () => {
  it('renders nothing when no file has unstyled candidates', () => {
    const { container } = render(
      <DocxPromoteControl
        files={[file(0, 'chapter.docx')]}
        onChange={vi.fn()}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('offers each eligible file independently and keeps promoted files reversible', async () => {
    const onChange = vi.fn();
    render(
      <DocxPromoteControl
        files={[
          file(3, 'chapter.docx', { unstyledCandidates: 4 }),
          file(7, 'chapter.docx', {
            unstyledCandidates: 6,
            promoted: true,
          }),
          file(8, 'notes.docx'),
        ]}
        onChange={onChange}
      />,
    );

    const promote = screen.getByRole('button', {
      name: /chapter\.docx.*treat 4 bold paragraphs as headings/i,
    });
    const restore = screen.getByRole('button', {
      name: /chapter\.docx.*use styled headings only/i,
    });

    await userEvent.click(promote);
    await userEvent.click(restore);

    expect(onChange).toHaveBeenNthCalledWith(1, 3, true);
    expect(onChange).toHaveBeenNthCalledWith(2, 7, false);
  });

  it('explains that existing styled headings remain for an eligible mixed file', () => {
    render(
      <DocxPromoteControl
        files={[
          file(2, 'mixed.docx', {
            styled: 3,
            unstyledCandidates: 7,
          }),
        ]}
        onChange={vi.fn()}
      />,
    );

    expect(screen.getByText(/styled headings remain/i)).toBeInTheDocument();
    expect(
      screen.getByRole('button', {
        name: /mixed\.docx.*treat 7 bold paragraphs as headings/i,
      }),
    ).toBeInTheDocument();
  });

  it('disables every file control while a re-request is in flight', () => {
    render(
      <DocxPromoteControl
        files={[
          file(1, 'one.docx', { unstyledCandidates: 1 }),
          file(2, 'two.docx', {
            unstyledCandidates: 2,
            promoted: true,
          }),
        ]}
        onChange={vi.fn()}
        disabled
      />,
    );

    for (const button of screen.getAllByRole('button')) {
      expect(button).toBeDisabled();
    }
  });
});
