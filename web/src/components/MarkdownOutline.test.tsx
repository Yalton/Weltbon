import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MarkdownOutline, extractMarkdownHeadings } from './MarkdownOutline';

const MARKDOWN = `---
title: Draft
---

# Intro

## Details

Scene Notes
---

\`\`\`md
# Hidden
\`\`\`

:::mermaid
graph TD
  A --> B
:::

## Details
`;

describe('MarkdownOutline', () => {
  it('extracts rendered headings in order with collision-safe anchors', () => {
    expect(extractMarkdownHeadings(MARKDOWN)).toEqual([
      {
        anchor: 'intro',
        depth: 1,
        end: MARKDOWN.indexOf('\n', MARKDOWN.indexOf('# Intro')),
        start: MARKDOWN.indexOf('# Intro'),
        text: 'Intro',
      },
      {
        anchor: 'details',
        depth: 2,
        end: MARKDOWN.indexOf('\n', MARKDOWN.indexOf('## Details')),
        start: MARKDOWN.indexOf('## Details'),
        text: 'Details',
      },
      {
        anchor: 'scene-notes',
        depth: 2,
        end: MARKDOWN.indexOf('---', MARKDOWN.indexOf('Scene Notes')) + 3,
        start: MARKDOWN.indexOf('Scene Notes'),
        text: 'Scene Notes',
      },
      {
        anchor: 'details-2',
        depth: 2,
        end: MARKDOWN.indexOf('\n', MARKDOWN.lastIndexOf('## Details')),
        start: MARKDOWN.lastIndexOf('## Details'),
        text: 'Details',
      },
    ]);
  });

  it('activates heading navigation from the keyboard', async () => {
    const onNavigate = vi.fn();
    render(<MarkdownOutline markdown={MARKDOWN} onNavigate={onNavigate} />);

    const headingButton = screen.getByRole('button', { name: 'Scene Notes' });
    headingButton.focus();
    await userEvent.keyboard('{Enter}');

    expect(onNavigate).toHaveBeenCalledWith({
      anchor: 'scene-notes',
      depth: 2,
      end: MARKDOWN.indexOf('---', MARKDOWN.indexOf('Scene Notes')) + 3,
      start: MARKDOWN.indexOf('Scene Notes'),
      text: 'Scene Notes',
    });
  });

  it('shows a meaningful empty state when the draft has no headings', () => {
    render(<MarkdownOutline markdown="Plain paragraph only." onNavigate={vi.fn()} />);

    expect(screen.getByText(/add a heading to build the outline/i)).toBeInTheDocument();
  });
});
