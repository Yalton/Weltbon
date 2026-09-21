import { LevelFormat, AlignmentType } from 'docx';

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
