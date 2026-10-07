# Ingest Fixture Vault

Synthetic Obsidian-style vault covering every edge case exercised by the Phase 11 markdown
ingestion parser. Files map directly to decisions D-07..D-17b from `11-CONTEXT.md`.

## vault-basic/

### `note-with-frontmatter.md`
**Decisions:** D-10 step 1, D-11 step 1, D-12, D-13
Frontmatter `title: "Custom Title"` overrides the `# Different H1` heading (D-10 step 1 wins).
`type: location` is used directly from frontmatter (D-11 step 1). Tags `[foo, bar]` come from
frontmatter (D-12). Exercises gray-matter string parsing (D-13).

### `Plain Heading Note.md`
**Decisions:** D-10 step 2
No frontmatter. Body starts with `# The Real Title`. Expected title = "The Real Title" (D-10 step 2
H1 fallback). Filename has spaces to verify that filename normalization is only applied at step 3.

### `no-h1-or-frontmatter.md`
**Decisions:** D-10 step 3, D-10a
Neither frontmatter nor H1. Expected title = "No h1 or frontmatter" (D-10a: hyphens → spaces,
capitalize first letter only).

### `characters/heroes/aragorn.md`
**Decisions:** D-07, D-11 step 2 (irregular-plural fallback walk)
- D-07: category = "heroes" (deepest folder)
- D-11 step 2: singularize "heroes" → "hero" (irregular plural) — "hero" may not be in validTypes;
  the heuristic walks up path segments to "characters" → "character" which IS in typical validTypes.
  Code comment in `ingest-markdown.ts` documents this parent-folder fallback.
Inline tags: `#ranger`, `#dunedain`.

### `characters/heroes/Frodo Baggins.md`
**Decisions:** D-07, D-11 step 2
Same folder as aragorn.md. category = "heroes". Type inferred as "character" via folder walk.
Filename with spaces exercises normalizeFilename when no frontmatter title is set and no H1 matches
(but there IS an H1 here).

### `locations/rivendell.md`
**Decisions:** D-07, D-11 step 2 (regular plural)
- D-07: category = "locations"
- D-11 step 2: "locations" → "location" (simple s-strip, IS in validTypes).

### `loc_minas_tirith.md`
**Decisions:** D-07 (null at root), D-10 step 3, D-11 step 3 (filename prefix)
At vault root → category = null (D-07). No frontmatter, no H1 → title from normalized filename
(D-10 step 3). Filename prefix `loc_` → type "location" (D-11 step 3 prefix table).

### `.obsidian/workspace.json`
**Decisions:** D-08a
Hidden directory (`.obsidian` starts with `.`). MUST be filtered before counting — not parsed,
not counted in markdown or non-markdown tallies. Simulates a real Obsidian vault metadata dir.

### `.trash/old.md`
**Decisions:** D-08a
Hidden directory (`.trash` starts with `.`). MUST be filtered before counting. Even though
it ends in `.md`, the path segment is hidden so it never reaches the parser.

### `attachments/banner.png`
**Decisions:** D-08
Non-`.md` file. MUST be silently skipped and counted in `non_markdown_files_skipped`.
The file is a valid 1×1 transparent PNG (minimal PNG binary; the parser only checks extension
so any non-empty buffer is sufficient for the test).

### `inline-tag-in-code.md`
**Decisions:** D-09a, D-12, D-17b
A fenced ` ```ts ` code block contains `#tag-in-code`. An inline backtick span contains
`#also-in-code`. Only the plain-body `#real-tag` should be extracted into tags (D-17b: use
remark AST tokenizer, NOT raw regex on full body). Expected tags = `["real-tag"]`.

### `yaml-dates.md`
**Decisions:** D-13, D-13a
Frontmatter contains `created: 2024-01-15` and `updated: 2024-06-30` — YAML date scalars.
gray-matter parses these as JS `Date` objects; `parseFrontmatter()` converts them to ISO 8601
strings. Expected: `meta.created === "2024-01-15T00:00:00.000Z"`.

### `duplicate-title-a.md` + `duplicate-title-b.md`
**Decisions:** D-05
Both resolve to title "Shared Title". The wikilink resolver (11-02) applies first-match-wins
and emits a warning for the second file. These fixtures drive the duplicate-title collision test.

## docx-gdocs/

Google-Docs-shaped `.docx` worldbuilding notes, rebuilt byte-for-byte by
`python3 -I docx-gdocs/build_gdocs.py` (stdlib only). The structure copies real
Docs exports: no Heading styles, direct run formatting, `w14:paraId`/rsid noise,
an empty header part, a comment. All text is invented.

- `pantheon-tabs.docx` — a tree kept as plain paragraphs; depth is only leading
  `<w:tab/>` runs or `w:ind firstLine`. Bold+underlined names, `{A||B}` pipes.
- `ranked-orders.docx` — a decimal `numPr` list of `Name: description` items and
  a chapter outline of plain lines with bullet lists, one nested.
- `chronicle.docx` — era titles that are only bold+underlined centred lines
  (heading-promotion candidates), a paragraph opening with a soft break + tab,
  dated timeline lines, a fake `1.` list marker, a bold opening quote mark
  (known flanking bug, Weltbon-izk) and one comment.

Used by `ingest-docx-gdocs-fixtures.test.ts` (conversion) and
`ingest-docx-gdocs-route.test.ts` (preview + commit through the routes).
