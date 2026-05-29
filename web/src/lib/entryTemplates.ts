/**
 * Entry templates registry for the Template Picker.
 *
 * Phase 28 v3.2: 6 default templates with ordered meta arrays (D-09),
 * rich multi-section bodies (D-08), and a metaArrayToRecord helper (D-10).
 * Typed meta-field variants (number/date/select) are deferred to a future phase (D-12).
 */

export interface EntryTemplateMetaField {
  name: string;
  /** D-12 — always typed as string in Phase 28; number/date/select variants deferred */
  default_value: string;
}

export interface EntryTemplate {
  id: string;
  label: string;
  /** Pre-fills EntryEditor's type select; freeform string per D-07. */
  entryType: string;
  /** Markdown scaffold; may be multi-line (D-11). */
  summary: string;
  /** Markdown with at least 2 ## headers (D-08). */
  body: string;
  /** Ordered blueprint fields (D-09); NOT Record<string,string>. */
  meta: EntryTemplateMetaField[];
  /** Short blurb shown under the picker card title. */
  description?: string;
}

export const TEMPLATES: EntryTemplate[] = [
  {
    id: 'character-detailed',
    label: 'Character-Detailed',
    entryType: 'entity',
    summary: 'A person (or being) in the world. Born in [place], [era]. Known for [trait or deed].',
    description: 'A richly scaffolded character entry covering appearance, history, and story role.',
    body: `## Appearance

Describe physical features, distinguishing marks, typical attire, and mannerisms.

## Personality

Core traits, virtues, flaws, and how they come across to strangers vs. those who know them.

## Background

Birthplace, family lineage, formative events, and the path that led them to where they are now.

## Relationships

Key bonds: allies, rivals, mentors, dependents. Note the nature and history of each relationship.

## Story Role

How this character functions in the narrative — protagonist, antagonist, mentor, foil, or other?
What arcs or threads do they drive or anchor?`,
    meta: [
      { name: 'species', default_value: '' },
      { name: 'gender', default_value: '' },
      { name: 'age', default_value: '' },
      { name: 'occupation', default_value: '' },
      { name: 'born', default_value: '' },
      { name: 'died', default_value: '' },
      { name: 'affiliation', default_value: '' },
      { name: 'goals', default_value: '' },
    ],
  },
  {
    id: 'location-settlement',
    label: 'Location-Settlement',
    entryType: 'location',
    summary: 'A settlement in [region]. Population: [size]. Governed by [authority].',
    description: 'A city, town, village, or outpost — with geography, politics, and local colour.',
    body: `## Geography

Physical setting: terrain, climate, nearby landmarks, and how the landscape shapes daily life.

## Inhabitants

Who lives here? Dominant cultures, languages, class structure, and notable demographics.

## Notable Sites

Key locations within the settlement: markets, temples, towers, slums, guildhalls, or ruins.

## History

Founding myth or documented origin, major events, conquests, disasters, or golden ages.

## Politics

Who holds power and how? Alliances, rivalries, trade relationships, and tensions with neighbours.`,
    meta: [
      { name: 'region', default_value: '' },
      { name: 'population', default_value: '' },
      { name: 'government', default_value: '' },
      { name: 'founded', default_value: '' },
      { name: 'notable_export', default_value: '' },
      { name: 'dominant_culture', default_value: '' },
    ],
  },
  {
    id: 'magic-system',
    label: 'Magic-System',
    entryType: 'magic-system',
    summary: 'A system of magic in the world. Powered by [source]. Limited by [cost or rule].',
    description: 'A structured magic system — source, cost, limits, and cultural footprint.',
    body: `## Source

Where does the power come from? A cosmic force, a deity, a substance, an innate faculty, or something stranger?

## Cost

What does using magic take from the practitioner or the world? Stamina, life-force, sacrifice, scarcity?

## Limits

What can magic NOT do? Hard rules, forbidden domains, diminishing returns, environmental constraints.

## Practitioners

Who can use magic and how do they learn? Guilds, bloodlines, clergy, wild talent, purchased tools?

## Cultural Impact

How does magic shape society, economy, warfare, religion, or daily life in this world?`,
    meta: [
      { name: 'source', default_value: '' },
      { name: 'cost', default_value: '' },
      { name: 'practitioners', default_value: '' },
      { name: 'forbidden_uses', default_value: '' },
      { name: 'cultural_status', default_value: '' },
      { name: 'discovered', default_value: '' },
    ],
  },
  {
    id: 'religion',
    label: 'Religion',
    entryType: 'religion',
    summary: 'A faith in the world. Worshipped by [followers]. Originated in [era / place].',
    description: 'A religion, pantheon, or spiritual tradition with doctrine, ritual, and hierarchy.',
    body: `## Cosmology

The faith's account of how the world came to be, what lies beyond death, and the nature of divine beings.

## Tenets

Core beliefs, moral commandments, and the values adherents are expected to embody.

## Rituals

Regular practices: worship services, rites of passage, festivals, offerings, and sacred observances.

## Clergy

The structure of religious authority — priests, orders, councils, prophets, or wandering mystics.

## Sects & Heresies

Internal divisions, splinter groups, heterodox interpretations, and historical schisms.`,
    meta: [
      { name: 'founder', default_value: '' },
      { name: 'pantheon', default_value: '' },
      { name: 'founded_era', default_value: '' },
      { name: 'holy_text', default_value: '' },
      { name: 'largest_sect', default_value: '' },
      { name: 'current_status', default_value: '' },
    ],
  },
  {
    id: 'conlang-word',
    label: 'Conlang-Word',
    entryType: 'conlang-word',
    summary: 'A word in [language name]. Meaning: [gloss]. Part of speech: [pos].',
    description: 'A single constructed-language vocabulary entry with pronunciation and usage.',
    body: `## Etymology

Root morphemes, historical derivation, borrowed forms, or the in-world mythological origin of the word.

## Usage Examples

Sample sentences or phrases demonstrating the word in context, with interlinear gloss where helpful.

## Notes

Dialectal variants, register (formal/colloquial/archaic), taboo status, or cultural connotations.`,
    meta: [
      { name: 'word', default_value: '' },
      { name: 'ipa', default_value: '' },
      { name: 'part_of_speech', default_value: '' },
      { name: 'gloss', default_value: '' },
      { name: 'etymology', default_value: '' },
    ],
  },
  {
    id: 'research-note',
    label: 'Research-Note',
    entryType: 'research-note',
    summary: 'A research note on [topic]. Status: [open / resolved]. Confidence: [low / medium / high].',
    description: 'A living document for tracking worldbuilding questions, sources, and findings.',
    body: `## Question

What is the specific question or problem this note is investigating?

## Sources

Where is the information coming from? In-world texts, author notes, external references, or speculation?

## Findings

Current best answers, evidence gathered, and reasoning applied so far.

## Open Threads

Sub-questions still unresolved, contradictions to reconcile, or follow-up tasks to complete.`,
    meta: [
      { name: 'topic', default_value: '' },
      { name: 'status', default_value: '' },
      { name: 'confidence', default_value: '' },
      { name: 'tags', default_value: '' },
      { name: 'next_step', default_value: '' },
    ],
  },
];

export function getTemplate(id: string): EntryTemplate | undefined {
  return TEMPLATES.find((t) => t.id === id);
}

/**
 * D-10 transform: convert the ordered meta blueprint array to a flat Record.
 * Used by EntryEditor's setMeta() call on the read path.
 * If duplicate field names exist (should not happen in well-formed templates),
 * last-write-wins.
 */
export function metaArrayToRecord(meta: EntryTemplateMetaField[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of meta) out[f.name] = f.default_value;
  return out;
}
