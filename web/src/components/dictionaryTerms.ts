/**
 * Phase 32 — plain-language definitions for the dictionary's linguistic terms.
 *
 * Surfaced as hover tooltips (native `title`) on the table column headers and
 * the inline editor fields so worldbuilders who aren't linguists understand
 * what each column means. Single source of truth for the copy.
 */
export const DICTIONARY_TERMS = {
  word: 'The headword — the term in your constructed language.',
  ipa: 'IPA (International Phonetic Alphabet): how the word is pronounced, e.g. /ˈmiːɾa/.',
  partOfSpeech:
    "Part of speech — the word's grammatical category: noun, verb, adjective, etc.",
  gloss: "Gloss — the word's meaning or translation in your own language.",
  etymology: "Etymology — the word's origin or history. Supports markdown.",
  tags: 'Tags — freeform labels for grouping and filtering words.',
} as const;
