
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createApp } from '../src/index.js';
import { createTestDb, cleanDb, createTestUser, authHeader, type TestDbHandle } from './helpers.js';
import { issueAccessToken } from '../src/services/auth.js';
import { setTestDb } from '../src/db/client.js';
import { importDictionaryCsv } from '../src/services/dictionary-import.js';
import { dictionaryWords, universes } from '../src/db/schema.js';
import { eq } from 'drizzle-orm';

describe('dictionary CSV import (CONLANG-02)', () => {
  let handle: TestDbHandle;
  let app: ReturnType<typeof createApp>;
  let universeId: string;
  let authHdrs: Record<string, string>;

  beforeAll(async () => {
    handle = await createTestDb();
    setTestDb(handle.db as any, handle.pool);
    app = createApp();
  });

  afterAll(async () => {
    await handle.cleanup();
  });

  beforeEach(async () => {
    await cleanDb(handle);
    // Create a fresh user + universe for each test
    const user = await createTestUser(handle, {
      email: `import-test-${Date.now()}@test.com`,
      password: 'longenoughpw12',
    });
    const token = await issueAccessToken(user.id);
    authHdrs = authHeader(token);
    const [univ] = await handle.db
      .insert(universes)
      .values({ userId: user.id, name: 'ImportWorld' })
      .returning();
    universeId = univ!.id;
  });

  // ─── Helpers ────────────────────────────────────────────────────────────

  function csv(rows: string[][]): Buffer {
    return Buffer.from(rows.map((r) => r.join(',')).join('\n'), 'utf-8');
  }

  // ─── D-09: Upsert OVERWRITES on collision ────────────────────────────────

  it('D-09: importing an existing word OVERWRITES gloss/ipa/pos/etymology/tags', async () => {
    // First import: insert initial row
    const initial = csv([
      ['word', 'gloss', 'ipa', 'pos', 'tags'],
      ['anar', 'sun body', 'a.nar', 'noun', 'celestial'],
    ]);
    const r1 = await importDictionaryCsv(initial, { universeId, languageEntryId: null });
    expect(r1.inserted).toBe(1);
    expect(r1.updated).toBe(0);

    // Second import: same word, different gloss/ipa
    const update = csv([
      ['word', 'gloss', 'ipa', 'tags'],
      ['anar', 'radiant sun', 'ˈa.nar', 'star;celestial'],
    ]);
    const r2 = await importDictionaryCsv(update, { universeId, languageEntryId: null });
    expect(r2.updated).toBe(1);
    expect(r2.inserted).toBe(0);

    // Verify the row was updated
    const [row] = await handle.db
      .select()
      .from(dictionaryWords)
      .where(eq(dictionaryWords.universeId, universeId));
    expect(row!.gloss).toBe('radiant sun');
    expect(row!.ipa).toBe('ˈa.nar');
    expect(row!.tags).toEqual(['star', 'celestial']);
  });

  // ─── D-10: Row errors don't abort valid rows ─────────────────────────────

  it('D-10: valid rows commit even when rowErrors is non-empty', async () => {
    const buf = csv([
      ['word', 'gloss'],
      ['good', 'valid word'],
      ['', ''],           // missing word and gloss → row error
      ['also-good', 'another valid word'],
    ]);
    const result = await importDictionaryCsv(buf, { universeId, languageEntryId: null });

    // Row errors should be non-empty (the empty row)
    expect(result.rowErrors.length).toBeGreaterThan(0);
    // But valid rows still committed
    expect(result.inserted).toBe(2);

    const rows = await handle.db
      .select()
      .from(dictionaryWords)
      .where(eq(dictionaryWords.universeId, universeId));
    expect(rows.length).toBe(2);
    const words = rows.map((r) => r.word).sort();
    expect(words).toEqual(['also-good', 'good']);
  });

  // ─── D-10: Lenient headers ───────────────────────────────────────────────

  it('D-10: extra columns in CSV are tolerated (lenient headers)', async () => {
    const buf = csv([
      ['word', 'gloss', 'extra_column', 'another_extra'],
      ['xeno', 'foreign', 'some_extra_value', 'more'],
    ]);
    const result = await importDictionaryCsv(buf, { universeId, languageEntryId: null });
    expect(result.rowErrors).toHaveLength(0);
    expect(result.inserted).toBe(1);
  });

  it('D-10: optional columns (ipa, pos, etymology, tags) can be absent', async () => {
    const buf = csv([
      ['word', 'gloss'],
      ['minimal', 'only required fields'],
    ]);
    const result = await importDictionaryCsv(buf, { universeId, languageEntryId: null });
    expect(result.rowErrors).toHaveLength(0);
    expect(result.inserted).toBe(1);

    const [row] = await handle.db
      .select()
      .from(dictionaryWords)
      .where(eq(dictionaryWords.universeId, universeId));
    expect(row!.word).toBe('minimal');
    expect(row!.ipa).toBe('');
    expect(row!.partOfSpeech).toBe('');
    expect(row!.etymology).toBe('');
    expect(row!.tags).toEqual([]);
  });

  it('D-10: reordered columns are tolerated', async () => {
    const buf = csv([
      ['gloss', 'word', 'ipa'],
      ['fire deity', 'xiuhtecuhtli', 'ʃiʍˌteːkʷtɬi'],
    ]);
    const result = await importDictionaryCsv(buf, { universeId, languageEntryId: null });
    expect(result.rowErrors).toHaveLength(0);
    expect(result.inserted).toBe(1);

    const [row] = await handle.db
      .select()
      .from(dictionaryWords)
      .where(eq(dictionaryWords.universeId, universeId));
    expect(row!.word).toBe('xiuhtecuhtli');
    expect(row!.gloss).toBe('fire deity');
    expect(row!.ipa).toBe('ʃiʍˌteːkʷtɬi');
  });

  // ─── D-10: Missing required headers ─────────────────────────────────────

  it('D-10: missing "word" header throws import-level error', async () => {
    const buf = csv([
      ['gloss', 'ipa'],
      ['fire', 'f.aɪ.ər'],
    ]);
    await expect(
      importDictionaryCsv(buf, { universeId, languageEntryId: null }),
    ).rejects.toThrow(/Missing required columns.*word/i);
  });

  it('D-10: missing "gloss" header throws import-level error', async () => {
    const buf = csv([
      ['word', 'ipa'],
      ['ignis', 'ˈig.nis'],
    ]);
    await expect(
      importDictionaryCsv(buf, { universeId, languageEntryId: null }),
    ).rejects.toThrow(/Missing required columns.*gloss/i);
  });

  // ─── D-10: Semicolon tag split ───────────────────────────────────────────

  it('D-10: tags cell is split on semicolons, not commas', async () => {
    const buf = csv([
      ['word', 'gloss', 'tags'],
      ['novus', 'new', 'noun;archaic;latin'],
    ]);
    const result = await importDictionaryCsv(buf, { universeId, languageEntryId: null });
    expect(result.rowErrors).toHaveLength(0);
    expect(result.inserted).toBe(1);

    const [row] = await handle.db
      .select()
      .from(dictionaryWords)
      .where(eq(dictionaryWords.universeId, universeId));
    expect(row!.tags).toEqual(['noun', 'archaic', 'latin']);
  });

  // ─── CR-03: field-length limits surface as per-row errors ───────────────

  it('CR-03: oversized word (>200 chars) surfaces as row error, valid rows still committed', async () => {
    const longWord = 'a'.repeat(201);
    const buf = csv([
      ['word', 'gloss'],
      [longWord, 'too long'],
      ['short', 'valid word'],
    ]);
    const result = await importDictionaryCsv(buf, { universeId, languageEntryId: null });
    expect(result.rowErrors.length).toBeGreaterThan(0);
    expect(result.rowErrors[0].row).toBe(1);
    expect(result.inserted).toBe(1); // 'short' committed
  });

  it('CR-03: oversized gloss (>1000 chars) surfaces as row error', async () => {
    const longGloss = 'g'.repeat(1001);
    const buf = csv([
      ['word', 'gloss'],
      ['anar', longGloss],
    ]);
    const result = await importDictionaryCsv(buf, { universeId, languageEntryId: null });
    expect(result.rowErrors.length).toBe(1);
    expect(result.inserted).toBe(0);
  });

  it('CR-03: oversized ipa (>200 chars) surfaces as row error', async () => {
    const longIpa = 'i'.repeat(201);
    const buf = csv([
      ['word', 'gloss', 'ipa'],
      ['sol', 'sun', longIpa],
    ]);
    const result = await importDictionaryCsv(buf, { universeId, languageEntryId: null });
    expect(result.rowErrors.length).toBe(1);
    expect(result.inserted).toBe(0);
  });

  it('CR-03: oversized partOfSpeech (>100 chars) surfaces as row error', async () => {
    const longPos = 'p'.repeat(101);
    const buf = csv([
      ['word', 'gloss', 'pos'],
      ['luna', 'moon', longPos],
    ]);
    const result = await importDictionaryCsv(buf, { universeId, languageEntryId: null });
    expect(result.rowErrors.length).toBe(1);
    expect(result.inserted).toBe(0);
  });

  it('CR-03: oversized tag string (>50 chars) surfaces as row error', async () => {
    const longTag = 't'.repeat(51);
    const buf = csv([
      ['word', 'gloss', 'tags'],
      ['nox', 'night', longTag],
    ]);
    const result = await importDictionaryCsv(buf, { universeId, languageEntryId: null });
    expect(result.rowErrors.length).toBe(1);
    expect(result.inserted).toBe(0);
  });

  it('CR-03: tag count exceeding 20 surfaces as row error', async () => {
    // 21 semicolon-delimited tags
    const tooManyTags = Array.from({ length: 21 }, (_, i) => `tag${i}`).join(';');
    const buf = csv([
      ['word', 'gloss', 'tags'],
      ['astrum', 'star', tooManyTags],
    ]);
    const result = await importDictionaryCsv(buf, { universeId, languageEntryId: null });
    expect(result.rowErrors.length).toBe(1);
    expect(result.inserted).toBe(0);
  });

  // ─── Route-level: 5 MB size cap ─────────────────────────────────────────

  it('T-32-04: POST /import with file > 5 MB returns 413', async () => {
    // Create a FormData with a fake 6 MB file
    const bigContent = 'a'.repeat(6 * 1024 * 1024);
    const file = new File([bigContent], 'big.csv', { type: 'text/csv' });
    const formData = new FormData();
    formData.append('file', file);

    const res = await app.request(
      `http://localhost/api/universes/${universeId}/dictionary/import`,
      {
        method: 'POST',
        headers: { ...authHdrs },
        body: formData,
      },
    );
    expect(res.status).toBe(413);
  });

  it('T-32-04: POST /import with valid CSV succeeds', async () => {
    const csvContent = 'word,gloss,ipa\nhello,greeting,hɛ.loʊ\nworld,earth,wɜːld\n';
    const file = new File([csvContent], 'words.csv', { type: 'text/csv' });
    const formData = new FormData();
    formData.append('file', file);

    const res = await app.request(
      `http://localhost/api/universes/${universeId}/dictionary/import`,
      {
        method: 'POST',
        headers: { ...authHdrs },
        body: formData,
      },
    );
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body).toHaveProperty('inserted');
    expect(body).toHaveProperty('updated');
    expect(body).toHaveProperty('rowErrors');
    expect(body.inserted).toBe(2);
    expect(body.rowErrors).toHaveLength(0);
  });

  // ─── WR-04: import ?lid= cross-universe rejection ───────────────────────

  it('WR-04: POST /import with ?lid= from another universe → 400', async () => {
    // Create a second user + universe
    const user2 = await createTestUser(handle, {
      email: `wr04-other-${Date.now()}@test.com`,
      password: 'longenoughpw12',
    });
    const [otherUniverse] = await handle.db
      .insert(universes)
      .values({ userId: user2.id, name: 'OtherWorld' })
      .returning();

    // Create a language entry in the OTHER universe
    // We need to insert via SQL since we don't want to go through the auth layer
    const { entries } = await import('../src/db/schema.js');
    const [langEntry] = await handle.db
      .insert(entries)
      .values({ universeId: otherUniverse!.id, userId: user2.id, title: 'Foreign Lang', entryType: 'language' })
      .returning();

    // Attempt to import to OUR universe with the foreign lid
    const csvContent = 'word,gloss\ntest,word\n';
    const file = new File([csvContent], 'words.csv', { type: 'text/csv' });
    const formData = new FormData();
    formData.append('file', file);

    const res = await app.request(
      `http://localhost/api/universes/${universeId}/dictionary/import?lid=${langEntry!.id}`,
      {
        method: 'POST',
        headers: { ...authHdrs },
        body: formData,
      },
    );
    expect(res.status).toBe(400);
    const body = await res.json() as any;
    expect(body.error).toMatch(/does not belong to this universe/i);
  });
});
