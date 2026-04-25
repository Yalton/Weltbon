import { LevelFormat, AlignmentType } from 'docx';

/**
 * Custom paragraph styles for the DOCX exporter.
 *
 * - `Quote` is the only style we override — italic + grey + indented so the
 *   per-entry summary callout reads as a quote block. Heading1/2/3,
 *   ListParagraph, and Hyperlink come from the docx package's defaults so
 *   Word's "Insert → Table of Contents" picks them up without us redefining
 *   the heading hierarchy.
 *
 * The `numbering` config defines a single "numbered-list" reference that
 * the walker uses for ordered lists. Without it, `numbering: { reference }`
 * on a Paragraph silently no-ops and ordered lists render as plain text.
 */
export const docxStyles = {
  paragraphStyles: [
    {
      id: 'Quote',
      name: 'Quote',
      basedOn: 'Normal',
      run: { italics: true, color: '666666' },
      paragraph: { indent: { left: 360 } },
    },
  ],
} as const;

export const docxNumbering = {
  config: [
    {
      reference: 'numbered-list',
      levels: [
        {
          level: 0,
          format: LevelFormat.DECIMAL,
          text: '%1.',
          alignment: AlignmentType.START,
          style: { paragraph: { indent: { left: 360, hanging: 260 } } },
        },
      ],
    },
  ],
} as const;
