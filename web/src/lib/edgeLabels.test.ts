import { describe, expect, it } from 'vitest';
import { edgeLabelAddsMeaning } from './edgeLabels';

describe('edgeLabelAddsMeaning', () => {
  it('drops a label that only repeats the target title, ignoring case and spacing', () => {
    expect(edgeLabelAddsMeaning('Machine Intelligences', 'Machine Intelligences')).toBe(false);
    expect(edgeLabelAddsMeaning('  machine   intelligences ', 'Machine Intelligences')).toBe(false);
  });

  it('drops a label that is the start of the target title or its singular', () => {
    expect(edgeLabelAddsMeaning('The Practice', 'The Practice — Fundamentals of Reality Manipulation')).toBe(false);
    expect(edgeLabelAddsMeaning('Ayin pocket', 'Ayin Pockets')).toBe(false);
  });

  it('drops a shortened form whose words all come from the target title', () => {
    expect(edgeLabelAddsMeaning('Major Ascended', 'The Major Ascended')).toBe(false);
    expect(edgeLabelAddsMeaning('Earth and Sol', 'Earth and the Sol System')).toBe(false);
    expect(edgeLabelAddsMeaning('Ascended', 'The Ascended Gods and Belief Systems')).toBe(false);
  });

  it('keeps a label that names a relationship', () => {
    expect(edgeLabelAddsMeaning('lives in', 'Frostspire Keep')).toBe(true);
    expect(edgeLabelAddsMeaning('Frails', 'People and Species')).toBe(true);
  });

  it('does not treat a label as a prefix when it stops partway through a word', () => {
    expect(edgeLabelAddsMeaning('The Prac', 'The Practice')).toBe(true);
  });

  it('drops empty labels', () => {
    expect(edgeLabelAddsMeaning(null, 'Anything')).toBe(false);
    expect(edgeLabelAddsMeaning('   ', 'Anything')).toBe(false);
  });
});
