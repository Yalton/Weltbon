import type { TestDbHandle } from '../helpers.js';
import { universes, categories, entries, timelinePins } from '../../src/db/schema.js';

/**
 * Seeds a "large" universe for Phase 3 tests that exercise filtering + FTS perf
 * at meaningful scale. Uses a fixed-seed PRNG (mulberry32) so test runs are
 * deterministic — the same seed always produces the same corpus.
 */
export interface SeedLargeUniverseOptions {
  entryCount?: number;
  categoryCount?: number;
  seed?: number;
  /**
   * Optional Phase-5 timeline pin seeding. When > 0, after entries are inserted,
   * `pinCount` pins are placed on a random subset of entries (deterministic via
   * the same mulberry32 stream). Precision distribution: ~50% exact, ~30%
   * approximate, ~20% era. Positions span [-10000, 5e17].
   */
  pinCount?: number;
}

export interface SeedLargeUniverseResult {
  universeId: string;
  categoryIds: string[];
  entryIds: string[];
  pinIds: string[];
}

const DEFAULT_ENTRY_TYPES = [
  'concept', 'entity', 'location', 'event', 'faction',
  'artifact', 'species', 'culture', 'thread',
];

const WORDS = [
  'dragon', 'capital', 'coast', 'sunder', 'ascend', 'forge', 'emerald', 'oracle',
  'tide', 'mountain', 'forest', 'ritual', 'chronicle', 'council', 'empire', 'artifact',
  'whisper', 'shadow', 'sigil', 'lament', 'bloom', 'ember', 'hollow', 'rift',
  'harbor', 'summit', 'vow', 'legion', 'exile', 'warden', 'heir', 'covenant',
  'scribe', 'beacon', 'wyrm', 'scourge', 'veil', 'runestone', 'citadel', 'tundra',
  'marsh', 'sanctum', 'herald', 'harbinger', 'verdant', 'obsidian', 'crimson', 'silent',
  'ancient', 'forgotten', 'binding', 'shattered', 'crown', 'pact', 'exalted', 'frost',
  'storm', 'vale', 'throne', 'ivory',
];

const TAG_VOCAB = ['capital', 'coast', 'dragon', 'ruin', 'city', 'era-1', 'era-2', 'legend', 'faction', 'outpost'];

const CATEGORY_LABELS = [
  'People — Nobles',
  'People — Commoners',
  'Places — Cities',
  'Places — Wilds',
  'Events — Wars',
  'Events — Rituals',
  'Concepts — Magic',
  'Concepts — Law',
];

/** Tiny seeded PRNG — mulberry32. Deterministic across platforms. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(rng: () => number, arr: readonly T[]): T {
  return arr[Math.floor(rng() * arr.length)]!;
}

function pickUnique<T>(rng: () => number, arr: readonly T[], count: number): T[] {
  const pool = [...arr];
  const out: T[] = [];
  for (let i = 0; i < count && pool.length > 0; i++) {
    const idx = Math.floor(rng() * pool.length);
    out.push(pool.splice(idx, 1)[0]!);
  }
  return out;
}

function buildTitle(rng: () => number): string {
  const a = pick(rng, WORDS);
  const b = pick(rng, WORDS);
  // Capitalize for readability
  const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
  const patterns = [
    `${cap(a)} of ${cap(b)}`,
    `The ${cap(a)} ${cap(b)}`,
    `${cap(a)}, ${cap(b)} of the ${pick(rng, WORDS)}`,
    `${cap(a)}-${b}`,
  ];
  return pick(rng, patterns);
}

function buildSentence(rng: () => number, wordCount: number): string {
  const words: string[] = [];
  for (let i = 0; i < wordCount; i++) words.push(pick(rng, WORDS));
  // Capitalize the first word and add a period.
  words[0] = words[0]!.charAt(0).toUpperCase() + words[0]!.slice(1);
  return words.join(' ') + '.';
}

function buildSummary(rng: () => number): string {
  const count = 1 + Math.floor(rng() * 2); // 1..2 sentences
  return Array.from({ length: count }, () => buildSentence(rng, 6 + Math.floor(rng() * 5))).join(' ');
}

function buildBody(rng: () => number): string {
  const count = 3 + Math.floor(rng() * 3); // 3..5 sentences
  return Array.from({ length: count }, () => buildSentence(rng, 10 + Math.floor(rng() * 8))).join(' ');
}

export async function seedLargeUniverse(
  handle: TestDbHandle,
  userId: string,
  opts: SeedLargeUniverseOptions = {}
): Promise<SeedLargeUniverseResult> {
  const entryCount = opts.entryCount ?? 220;
  const categoryCount = opts.categoryCount ?? 8;
  const seed = opts.seed ?? 42;
  const rng = mulberry32(seed);

  // Insert universe
  const [universe] = await handle.db
    .insert(universes)
    .values({
      userId,
      name: 'Large Seeded Universe',
      description: 'Deterministic fixture for Phase 3 filter + FTS tests',
      entryTypes: DEFAULT_ENTRY_TYPES,
    })
    .returning({ id: universes.id });

  if (!universe) throw new Error('seedLargeUniverse: failed to insert universe');

  // Insert categories — batch, preserve requested count
  const categoryRows = Array.from({ length: categoryCount }, (_, i) => ({
    universeId: universe.id,
    label: CATEGORY_LABELS[i % CATEGORY_LABELS.length]!,
    icon: '',
    sortOrder: i,
  }));
  const insertedCategories = await handle.db
    .insert(categories)
    .values(categoryRows)
    .returning({ id: categories.id });
  const categoryIds = insertedCategories.map((c) => c.id);

  // Insert entries — batch in chunks so we don't blow up parameter limits
  const entryRows = Array.from({ length: entryCount }, (_, i) => {
    const entryType = DEFAULT_ENTRY_TYPES[i % DEFAULT_ENTRY_TYPES.length]!;
    // Every 3rd entry uncategorized (exercises IS NULL filter path)
    const categoryId = i % 3 === 0 ? null : categoryIds[i % categoryIds.length]!;
    const tagCount = 2 + Math.floor(rng() * 2); // 2..3 tags
    const tags = pickUnique(rng, TAG_VOCAB, tagCount);
    return {
      universeId: universe.id,
      title: buildTitle(rng),
      entryType,
      summary: buildSummary(rng),
      body: buildBody(rng),
      tags,
      categoryId,
    };
  });

  const entryIds: string[] = [];
  const CHUNK = 50;
  for (let i = 0; i < entryRows.length; i += CHUNK) {
    const slice = entryRows.slice(i, i + CHUNK);
    const inserted = await handle.db
      .insert(entries)
      .values(slice)
      .returning({ id: entries.id });
    for (const row of inserted) entryIds.push(row.id);
  }

  // Phase-5: optional timeline pin seeding for Plan 02 perf tests.
  const pinIds: string[] = [];
  const pinCount = opts.pinCount ?? 0;
  if (pinCount > 0) {
    // Pick `pinCount` distinct entry indices via the same PRNG stream so the
    // distribution stays deterministic across runs (UNIQUE on entry_id forbids
    // duplicates anyway, so we pick without replacement).
    const indices = pickUnique(rng, entryIds, Math.min(pinCount, entryIds.length));
    const PIN_MIN = -10000;
    const PIN_MAX = 5e17;
    const PIN_RANGE = PIN_MAX - PIN_MIN;
    const pinRows = indices.map((entryId, i) => {
      const r = rng();
      // 50% exact, 30% approximate, 20% era
      const precision = r < 0.5 ? 'exact' : r < 0.8 ? 'approximate' : 'era';
      const position = PIN_MIN + rng() * PIN_RANGE;
      return {
        entryId,
        label: `Pin ${i}`,
        position,
        precision,
      };
    });
    // Chunk inserts the same way entries are chunked.
    for (let i = 0; i < pinRows.length; i += CHUNK) {
      const slice = pinRows.slice(i, i + CHUNK);
      const inserted = await handle.db
        .insert(timelinePins)
        .values(slice)
        .returning({ id: timelinePins.id });
      for (const row of inserted) pinIds.push(row.id);
    }
  }

  return { universeId: universe.id, categoryIds, entryIds, pinIds };
}
