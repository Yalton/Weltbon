/**
 * Tests for filename/path wikilink resolution during markdown ingest (#60).
 *
 * An Obsidian vault links by file, not by H1: `[[ayin_pockets|Ayin pocket]]`
 * targets `ayin_pockets.md`, whose rendered title is "Ayin Pockets". Before
 * this, parseBatch keyed resolution on the inferred title alone, so every such
 * link was reported unresolved even though the target was in the same upload.
 *
 * Resolution order asserted here (see resolveBatchTarget in ingest-markdown.ts):
 *   title → exact path → unique basename → existing title → existing alias
 */

import { describe, it, expect } from 'vitest';
import {
  parseBatch,
  type ParseBatchContext,
  type FileInput,
} from '../src/services/ingest-markdown.js';

const CTX: ParseBatchContext = {
  universeId: 'test-universe',
  validTypes: ['character', 'location', 'event', 'concept'],
  existingEntries: [],
  existingCategories: [],
};

function file(path: string, content: string): FileInput {
  return { path, content };
}

function linksOf(preview: ReturnType<typeof parseBatch>, path: string) {
  const entry = preview.entries.find(e => e.path === path);
  if (!entry) throw new Error(`no entry for ${path}`);
  return entry.linksOut;
}

describe('parseBatch — filename and path wikilinks (#60)', () => {
  it('resolves a bare filename reference to the file with that basename', () => {
    const preview = parseBatch(
      [
        file('notes/index.md', '# Index\n\nSee [[ayin_pockets|Ayin pocket]].\n'),
        file('notes/ayin_pockets.md', '# Ayin Pockets\n\nBody.\n'),
      ],
      CTX,
    );

    const [link] = linksOf(preview, 'notes/index.md');
    expect(link.resolved).toBe(true);
    expect(link.target_path).toBe('notes/ayin_pockets.md');
    // The alias is what the reader sees; resolution must not disturb it.
    expect(link.label).toBe('Ayin pocket');
    expect(preview.summary.unresolved_wikilinks).toBe(0);
  });

  it('resolves a folder-relative path reference', () => {
    const preview = parseBatch(
      [
        file('index.md', '# Index\n\nSee [[lore/ayin_pockets]].\n'),
        file('lore/ayin_pockets.md', '# Ayin Pockets\n\nBody.\n'),
      ],
      CTX,
    );

    const [link] = linksOf(preview, 'index.md');
    expect(link.resolved).toBe(true);
    expect(link.target_path).toBe('lore/ayin_pockets.md');
  });

  it('resolves a path reference written with a leading ./', () => {
    const preview = parseBatch(
      [
        file('index.md', '# Index\n\nSee [[./lore/ayin_pockets]].\n'),
        file('lore/ayin_pockets.md', '# Ayin Pockets\n\nBody.\n'),
      ],
      CTX,
    );

    expect(linksOf(preview, 'index.md')[0].target_path).toBe('lore/ayin_pockets.md');
  });

  it('prefers a title match over a basename match', () => {
    // `notes.md` is titled "Glossary"; a different file is titled "notes".
    // Obsidian resolves [[notes]] to the file, but our entries are addressed by
    // title once imported, so an exact title must not be shadowed by a filename.
    const preview = parseBatch(
      [
        file('index.md', '# Index\n\nSee [[notes]].\n'),
        file('notes.md', '# Glossary\n\nBody.\n'),
        file('other.md', '# notes\n\nBody.\n'),
      ],
      CTX,
    );

    expect(linksOf(preview, 'index.md')[0].target_path).toBe('other.md');
  });

  it('leaves an ambiguous basename unresolved and says why', () => {
    const preview = parseBatch(
      [
        file('index.md', '# Index\n\nSee [[notes]].\n'),
        file('a/notes.md', '# A Notes\n\nBody.\n'),
        file('b/notes.md', '# B Notes\n\nBody.\n'),
      ],
      CTX,
    );

    const [link] = linksOf(preview, 'index.md');
    expect(link.resolved).toBe(false);
    expect(link.warning).toMatch(/2 files/);
    // The disambiguating form still works.
    expect(linksOf(parseBatch(
      [
        file('index.md', '# Index\n\nSee [[a/notes]].\n'),
        file('a/notes.md', '# A Notes\n\nBody.\n'),
        file('b/notes.md', '# B Notes\n\nBody.\n'),
      ],
      CTX,
    ), 'index.md')[0].target_path).toBe('a/notes.md');
  });

  it('resolves against an already-imported entry via its source-path alias', () => {
    const preview = parseBatch(
      [file('index.md', '# Index\n\nSee [[lore/ayin_pockets]].\n')],
      {
        ...CTX,
        existingEntries: [
          { id: 'entry-1', title: 'Ayin Pockets', aliases: ['lore/ayin_pockets', 'ayin_pockets'] },
        ],
      },
    );

    const [link] = linksOf(preview, 'index.md');
    expect(link.resolved).toBe(true);
    expect(link.target_id).toBe('entry-1');
  });

  it('counts a genuinely missing file as unresolved', () => {
    const preview = parseBatch(
      [file('index.md', '# Index\n\nSee [[nowhere/at_all]].\n')],
      CTX,
    );

    expect(linksOf(preview, 'index.md')[0].resolved).toBe(false);
    expect(preview.summary.unresolved_wikilinks).toBe(1);
  });
});
