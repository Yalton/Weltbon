import { describe, it, expect } from 'vitest';
import { buildFontFaceBlock } from '../src/services/export/pdf/fonts.js';
import {
  renderUniverseHtml,
  footerTemplate,
  escapeHtml,
} from '../src/services/export/pdf/template.js';
import type { ExportPayload } from '../src/services/export/payload.js';

/**
 * Plan 04-03 Task 1 unit-level coverage. These tests do NOT need Chromium —
 * they exercise the HTML template + font block generators in isolation.
 *
 * The font block tolerates missing woff2 files on disk; this test runs in
 * environments without bundled fonts and asserts the function still returns
 * a string (possibly empty, with stderr warnings) instead of crashing.
 */

function buildFixturePayload(): ExportPayload {
  // Minimal payload covering the structural cases: 2 categories with sortOrder,
  // 1 uncategorized entry, an entry with a colon in title (escaped), an entry
  // with a body that includes a markdown link, a bidirectional link, and one
  // open issue. Slug map is hand-stitched.
  const slugMap = new Map<string, string>([
    ['e1', 'alpha'],
    ['e2', 'beta'],
    ['e3', 'orphan'],
  ]);
  return {
    universe: {
      id: 'u1',
      name: 'Pdf Test Universe',
      description: 'A short subtitle',
      entryTypes: ['entity', 'concept'],
      // Phase 20 D-01 + Phase 35 REL-01: required fields on ExportPayloadUniverse
      timelineWindow: null,
      linkTypes: {},
      // Plan A2 (A2-06): required universe-level fields on ExportPayloadUniverse
      calendar: null,
      theme: null,
      fieldRegistry: [],
      auditEnabled: false,
      auditProvider: null,
      auditModel: null,
    },
    categories: [
      { id: 'c1', label: 'People', icon: '', sortOrder: 0, createdAt: new Date(), updatedAt: new Date() },
      { id: 'c2', label: 'Places', icon: '', sortOrder: 1, createdAt: new Date(), updatedAt: new Date() },
    ],
    entries: [
      {
        id: 'e1',
        title: 'Alpha: With Colon',
        entryType: 'entity',
        summary: 'A short summary',
        body: '## Body Heading\n\nSome **bold** text and a [link](http://example.com).',
        tags: ['tag1', 'tag2'],
        // Phase 45 XREF-04 (D-08) + Phase 38 MEDIA-04 (D-06): required on ExportPayloadEntry.
        aliases: [],
        coverImageId: null,
        meta: {},
        icon: '',
        categoryId: 'c1',
        isPublic: false,
        createdAt: new Date('2026-01-01T00:00:00Z'),
        updatedAt: new Date('2026-01-01T00:00:00Z'),
      },
      {
        id: 'e2',
        title: 'Beta',
        entryType: 'concept',
        summary: '',
        body: 'plain body',
        tags: [],
        aliases: [],
        coverImageId: null,
        meta: {},
        icon: '',
        categoryId: 'c2',
        isPublic: false,
        createdAt: new Date('2026-01-02T00:00:00Z'),
        updatedAt: new Date('2026-01-02T00:00:00Z'),
      },
      {
        id: 'e3',
        title: 'Orphan Entry',
        entryType: 'entity',
        summary: 'orphan summary',
        body: '',
        tags: ['solo'],
        aliases: [],
        coverImageId: null,
        meta: {},
        icon: '',
        categoryId: null,
        isPublic: false,
        createdAt: new Date('2026-01-03T00:00:00Z'),
        updatedAt: new Date('2026-01-03T00:00:00Z'),
      },
    ],
    links: [
      {
        id: 'l1',
        sourceEntryId: 'e1',
        targetEntryId: 'e2',
        label: 'knows',
        // Phase 35 REL-01: direction replaces bidirectional; 'undirected' = was bidirectional=true
        direction: 'undirected',
        linkType: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ],
    openIssues: [
      {
        id: 'i1',
        title: 'A blocking concern',
        description: 'needs follow-up',
        severity: 'critical',
        resolved: false,
        createdAt: new Date(),
        updatedAt: new Date(),
        entryIds: ['e1'],
      },
    ],
    fullIssues: [],
    graphPositions: [],
    timelinePins: [],
    entrySlugMap: slugMap,
    // Phase 38 MEDIA-06 (D-07) + Phase 41/44/51: required collections on ExportPayload.
    assets: [],
    maps: [],
    mapPins: [],
    mapRegions: [],
    mapRoutes: [],
    mapLayersData: [],
    terrainTypesData: [],
    // Plan A2: required new collections on ExportPayload (dictionary/diagrams/shareTokens).
    dictionaryWords: [],
    diagrams: [],
    diagramNodes: [],
    shareTokens: [],
  };
}

describe('Plan 04-03 Task 1: pdf/fonts.ts', () => {
  it('buildFontFaceBlock returns a string (possibly empty when fonts are missing)', async () => {
    const block = await buildFontFaceBlock();
    expect(typeof block).toBe('string');
    // when fonts ARE present it should at least mention font-face; when absent the empty string is fine.
    if (block.length > 0) {
      expect(block).toMatch(/@font-face/);
    }
  });
});

describe('Plan 04-03 Task 1: pdf/template.ts', () => {
  it('escapeHtml escapes the dangerous five characters', () => {
    expect(escapeHtml('a & b < c > d " e \' f')).toBe(
      'a &amp; b &lt; c &gt; d &quot; e &#39; f',
    );
  });

  it('footerTemplate substitutes the universe name and includes pageNumber span', () => {
    const html = footerTemplate('My "World" & Co');
    expect(html).toContain('class="pageNumber"');
    expect(html).toContain('My &quot;World&quot; &amp; Co');
  });

  it('renderUniverseHtml emits a complete document with title page, TOC anchors, and body sections', async () => {
    const html = await renderUniverseHtml(buildFixturePayload());

    // structural
    expect(html.startsWith('<!DOCTYPE html>')).toBe(true);
    expect(html).toContain('<style>');
    expect(html).toContain('@page');

    // title page
    expect(html).toContain('Pdf Test Universe');
    expect(html).toContain('A short subtitle');
    expect(html).toContain('2 categories');
    expect(html).toContain('3 entries');
    // forced page break after title page
    expect(html).toMatch(/page-break-after:\s*always/);

    // TOC anchors
    expect(html).toContain('Contents');
    expect(html).toContain('href="#cat-c1"');
    expect(html).toContain('href="#cat-c2"');
    expect(html).toContain('href="#cat-uncategorized"');
    expect(html).toContain('href="#entry-e1"');
    expect(html).toContain('href="#entry-e2"');
    expect(html).toContain('href="#entry-e3"');

    // body
    expect(html).toContain('id="cat-c1"');
    expect(html).toContain('id="cat-c2"');
    expect(html).toContain('id="cat-uncategorized"');
    expect(html).toContain('id="entry-e1"');
    expect(html).toContain('id="entry-e2"');
    expect(html).toContain('id="entry-e3"');

    // entry metadata + summary callout
    expect(html).toContain('Type: entity');
    expect(html).toContain('Tags: tag1, tag2');
    expect(html).toMatch(/blockquote class="summary"/);

    // body markdown rendered to HTML (remark): bold + heading + link
    expect(html).toContain('<strong>bold</strong>');
    expect(html).toMatch(/<h2[^>]*>Body Heading<\/h2>/);
    expect(html).toContain('href="http://example.com"');

    // links section (bidirectional shows up on both sides)
    expect(html).toContain('href="#entry-e2"'); // already asserted in TOC; appears again in body Links section for e1
    expect(html).toContain('href="#entry-e1"'); // reverse direction for e2 (bidirectional)

    // open issue
    expect(html).toContain('Open Issues');
    expect(html).toContain('severity-CRITICAL');
    expect(html).toContain('A blocking concern');

    // colon in title escaped — title should appear and the H2 id is "entry-e1"
    expect(html).toContain('Alpha: With Colon');
  });

  it('renderUniverseHtml escapes potentially dangerous content', async () => {
    const payload = buildFixturePayload();
    payload.universe.name = 'Tag <script>alert(1)</script> World';
    const html = await renderUniverseHtml(payload);
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('Tag &lt;script&gt;alert(1)&lt;/script&gt; World');
  });
});
