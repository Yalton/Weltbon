// RED stub — implementation lands in GREEN step.
import type { Root } from 'mdast';
import type { Paragraph, Table } from 'docx';

export function mdastToDocx(_root: Root, _base: 3 | 4 = 3): Array<Paragraph | Table> {
  throw new Error('mdastToDocx: not yet implemented (RED step)');
}
