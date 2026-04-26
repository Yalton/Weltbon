/**
 * Entry templates registry for the Template Picker (Plan 07 consumes).
 *
 * Source: 05-CONTEXT.md §POL-04; researcher-recommended content per built-in
 * type from 05-RESEARCH.md §11. Custom user-defined entry types use Blank
 * (the picker UI applies that fallback when no template id matches).
 */
export interface EntryTemplate {
  id: string;
  label: string;
  /** Pre-fills EntryEditor's type select; '' for Blank. */
  entryType: string;
  category: 'Setting' | 'People' | 'Things' | 'Time' | 'Other';
  body: string;
  meta: Record<string, string>;
  /** Shown on the picker card. */
  description?: string;
}

export const TEMPLATES: EntryTemplate[] = [
  {
    id: 'blank',
    label: 'Blank',
    entryType: '',
    category: 'Other',
    body: '',
    meta: {},
    description: 'Start with an empty entry.',
  },
  // Setting
  {
    id: 'concept',
    label: 'Concept',
    entryType: 'concept',
    category: 'Setting',
    body: '## Definition\n\n## Origin\n\n## Implications',
    meta: { domain: '', era: '' },
    description: 'A worldbuilding idea or framework.',
  },
  {
    id: 'location',
    label: 'Location',
    entryType: 'location',
    category: 'Setting',
    body: '## Geography\n\n## Population\n\n## Government\n\n## Notable Locations',
    meta: { region: '', climate: '', population: '' },
    description: 'A place: city, region, biome.',
  },
  {
    id: 'culture',
    label: 'Culture',
    entryType: 'culture',
    category: 'Setting',
    body: '## Values\n\n## Traditions\n\n## Language',
    meta: { region: '', language_family: '' },
    description: "A people's way of life.",
  },
  {
    id: 'species',
    label: 'Species',
    entryType: 'species',
    category: 'Setting',
    body: '## Description\n\n## Culture\n\n## Range',
    meta: { lifespan: '', habitat: '' },
    description: 'A type of being.',
  },
  // People
  {
    id: 'entity',
    label: 'Entity',
    entryType: 'entity',
    category: 'People',
    body: '## Background\n\n## Appearance\n\n## Motivations\n\n## Notable Acts',
    meta: { born: '', died: '', affiliation: '' },
    description: 'An individual character or being.',
  },
  {
    id: 'faction',
    label: 'Faction',
    entryType: 'faction',
    category: 'People',
    body: '## Goals\n\n## Structure\n\n## Members',
    meta: { founded: '', leader: '', headquarters: '' },
    description: 'An organized group.',
  },
  // Things
  {
    id: 'artifact',
    label: 'Artifact',
    entryType: 'artifact',
    category: 'Things',
    body: '## Description\n\n## Powers\n\n## History',
    meta: { material: '', origin: '', current_location: '' },
    description: 'An object of significance.',
  },
  // Time
  {
    id: 'event',
    label: 'Event',
    entryType: 'event',
    category: 'Time',
    body: '## Summary\n\n## Causes\n\n## Aftermath',
    meta: { start: '', end: '', participants: '' },
    description: 'A historical happening.',
  },
  {
    id: 'thread',
    label: 'Thread',
    entryType: 'thread',
    category: 'Time',
    body: '## Setup\n\n## Development\n\n## Resolution',
    meta: { started: '', status: '' },
    description: 'A storyline or arc.',
  },
];

export function getTemplate(id: string): EntryTemplate | undefined {
  return TEMPLATES.find((t) => t.id === id);
}

/** Category groupings drive the picker UI. Order matters: shown left-to-right. */
export const TEMPLATE_GROUPS: Array<{ label: string; templates: EntryTemplate[] }> = [
  { label: 'Setting', templates: TEMPLATES.filter((t) => t.category === 'Setting') },
  { label: 'People', templates: TEMPLATES.filter((t) => t.category === 'People') },
  { label: 'Things', templates: TEMPLATES.filter((t) => t.category === 'Things') },
  { label: 'Time', templates: TEMPLATES.filter((t) => t.category === 'Time') },
  { label: 'Other', templates: TEMPLATES.filter((t) => t.category === 'Other') }, // Blank
];
