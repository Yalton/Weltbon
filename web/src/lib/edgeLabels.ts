const words = (text: string) =>
  text
    .toLowerCase()
    .replace(/[—–-]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => word.replace(/s$/, ''));

/**
 * Whether a link's label tells the reader something its target node does not.
 * Imported notes store each [[wikilink]]'s text as the label, so most labels
 * just repeat or shorten the title the line already points at ("Machine
 * Intelligences", "The Practice" for "The Practice — Fundamentals …", "Earth
 * and Sol" for "Earth and the Sol System"). Drawing those buries the graph in
 * duplicate titles; a label with words of its own ("lives in") still shows.
 */
export function edgeLabelAddsMeaning(label: string | null, targetTitle: string): boolean {
  const labelWords = words(label ?? '');
  if (labelWords.length === 0) return false;
  const titleWords = new Set(words(targetTitle));
  return labelWords.some((word) => !titleWords.has(word));
}
