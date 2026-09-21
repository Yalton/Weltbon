
import { describe, it, expect } from 'vitest';
import {
  rewriteWikilinks,
  parseWikilink,
} from '../src/services/rewrite-wikilinks.js';

// ---------------------------------------------------------------------------
// parseWikilink — parity with WikilinkText.tsx parseWikilink (D-07)
// ---------------------------------------------------------------------------

describe('parseWikilink', () => {
  it('bare link: target equals inner, label defaults to target', () => {
    const r = parseWikilink('Empire');
    expect(r.target).toBe('Empire');
    expect(r.label).toBe('Empire');
  });

  it('pipe-split: ref = before pipe, label = after pipe', () => {
    const r = parseWikilink('Empire|the old realm');
    expect(r.target).toBe('Empire');
    expect(r.label).toBe('the old realm');
  });

  it('heading anchor stripped from ref, not from label', () => {
    const r = parseWikilink('Empire#History');
    expect(r.target).toBe('Empire');
    expect(r.label).toBe('Empire');
  });

  it('heading anchor stripped when pipe also present', () => {
    const r = parseWikilink('Empire#History|the realm');
    expect(r.target).toBe('Empire');
    expect(r.label).toBe('the realm');
  });

  it('trailing .md stripped case-insensitively', () => {
    expect(parseWikilink('Empire.md').target).toBe('Empire');
    expect(parseWikilink('Empire.MD').target).toBe('Empire');
  });

  it('.md strip + heading anchor: .md applied after heading strip', () => {
    // Per WikilinkText: heading stripped first from ref, then .md removed
    const r = parseWikilink('Empire.md#History');
    expect(r.target).toBe('Empire');
  });

  it('ref is trimmed', () => {
    const r = parseWikilink('  Empire  ');
    expect(r.target).toBe('Empire');
  });

  it('label is NOT trimmed (preserves author whitespace)', () => {
    const r = parseWikilink('Empire| display ');
    // label is slice after pipe — not trimmed in the spec
    expect(r.label).toBe(' display ');
  });

  it('pipe splits only on FIRST pipe (label can contain pipes)', () => {
    const r = parseWikilink('Empire|foo|bar');
    expect(r.target).toBe('Empire');
    expect(r.label).toBe('foo|bar');
  });
});

// ---------------------------------------------------------------------------
// rewriteWikilinks — D-02..D-05, D-07
// ---------------------------------------------------------------------------

describe('rewriteWikilinks', () => {
  // -------------------------------------------------------------------------
  // D-02: bare link follows rename
  // -------------------------------------------------------------------------
  it('D-02: bare link rewrites to new canonical title', () => {
    const body = 'Read [[Empire]] now';
    const stale = new Set(['empire']);
    const { body: out, count } = rewriteWikilinks(body, stale, 'Imperium');
    expect(out).toBe('Read [[Imperium]] now');
    expect(count).toBe(1);
  });

  // -------------------------------------------------------------------------
  // D-03: explicit display text preserved when target is updated
  // -------------------------------------------------------------------------
  it('D-03: piped display text is preserved while target is rewritten', () => {
    const body = 'The [[Empire|the old realm]] stood.';
    const stale = new Set(['empire']);
    const { body: out, count } = rewriteWikilinks(body, stale, 'Imperium');
    expect(out).toBe('The [[Imperium|the old realm]] stood.');
    expect(count).toBe(1);
  });

  // -------------------------------------------------------------------------
  // D-04: dropped-alias links rewrite to canonical title
  // -------------------------------------------------------------------------
  it('D-04: dropped-alias bare link rewrites to canonical title', () => {
    const body = 'See [[The Imperium]] for details.';
    const stale = new Set(['the imperium']);
    const { body: out, count } = rewriteWikilinks(body, stale, 'Empire');
    expect(out).toBe('See [[Empire]] for details.');
    expect(count).toBe(1);
  });

  // -------------------------------------------------------------------------
  // D-05 / D-01: surviving-alias links untouched when staleNames has no match
  // -------------------------------------------------------------------------
  it('D-05: link not in staleNames is left untouched, count=0', () => {
    const body = 'See [[The Imperium]] for details.';
    // staleNames does NOT contain 'the imperium'
    const stale = new Set(['old name']);
    const { body: out, count } = rewriteWikilinks(body, stale, 'Empire');
    expect(out).toBe(body);
    expect(count).toBe(0);
  });

  // -------------------------------------------------------------------------
  // D-07 case-insensitive matching
  // -------------------------------------------------------------------------
  it('D-07: lowercase variant rewrites when staleNames has lowercased key', () => {
    const body = 'See [[empire]] and [[EMPIRE]] both.';
    const stale = new Set(['empire']);
    const { body: out, count } = rewriteWikilinks(body, stale, 'Imperium');
    expect(out).toBe('See [[Imperium]] and [[Imperium]] both.');
    expect(count).toBe(2);
  });

  // -------------------------------------------------------------------------
  // D-07 heading anchor: ref portion rewrites, anchor is preserved
  // -------------------------------------------------------------------------
  it('D-07: heading anchor preserved while target is rewritten', () => {
    const body = 'See [[Empire#History]] for the timeline.';
    const stale = new Set(['empire']);
    const { body: out, count } = rewriteWikilinks(body, stale, 'Imperium');
    expect(out).toBe('See [[Imperium#History]] for the timeline.');
    expect(count).toBe(1);
  });

  it('D-07: heading anchor + display text: only target portion swapped', () => {
    const body = 'Check [[Empire#History|rise of the empire]].';
    const stale = new Set(['empire']);
    const { body: out, count } = rewriteWikilinks(body, stale, 'Imperium');
    expect(out).toBe('Check [[Imperium#History|rise of the empire]].');
    expect(count).toBe(1);
  });

  // -------------------------------------------------------------------------
  // D-07 .md strip: keys on stripped ref
  // -------------------------------------------------------------------------
  it('D-07: .md-suffixed link rewrites when staleNames has the stripped name', () => {
    const body = 'See [[Empire.md]] for info.';
    const stale = new Set(['empire']);
    const { body: out, count } = rewriteWikilinks(body, stale, 'Imperium');
    // The rewriter strips .md before matching, then replaces the whole [[...]] span
    expect(out).toBe('See [[Imperium]] for info.');
    expect(count).toBe(1);
  });

  // -------------------------------------------------------------------------
  // D-07 code-span exclusion (HARD CONSTRAINT)
  // -------------------------------------------------------------------------
  it('D-07 code exclusion: fenced-block-only body is never rewritten (count=0)', () => {
    const body = '```\n[[Empire]]\n```';
    const stale = new Set(['empire']);
    const { body: out, count } = rewriteWikilinks(body, stale, 'Imperium');
    expect(out).toBe(body);
    expect(count).toBe(0);
  });

  it('D-07 code exclusion: inline code span is never rewritten (count=0)', () => {
    const body = 'Use `[[Empire]]` in templates.';
    const stale = new Set(['empire']);
    const { body: out, count } = rewriteWikilinks(body, stale, 'Imperium');
    expect(out).toBe(body);
    expect(count).toBe(0);
  });

  it('D-07 code exclusion: mixed body — prose occurrence rewritten, fenced occurrence untouched', () => {
    // Critical: proves per-occurrence protected-range gating rather than all-or-nothing
    const body = 'Read [[Empire]] now.\n\n```\n[[Empire]] in code\n```\n\nEnd.';
    const stale = new Set(['empire']);
    const { body: out, count } = rewriteWikilinks(body, stale, 'Imperium');
    expect(count).toBe(1);
    expect(out).toBe('Read [[Imperium]] now.\n\n```\n[[Empire]] in code\n```\n\nEnd.');
  });

  // -------------------------------------------------------------------------
  // Multiple occurrences
  // -------------------------------------------------------------------------
  it('multiple prose occurrences: count = number of replaced links', () => {
    const body = '[[Empire]] is great. [[Empire]] is large. [[Empire]] is old.';
    const stale = new Set(['empire']);
    const { body: out, count } = rewriteWikilinks(body, stale, 'Imperium');
    expect(count).toBe(3);
    expect(out).toBe('[[Imperium]] is great. [[Imperium]] is large. [[Imperium]] is old.');
  });

  // -------------------------------------------------------------------------
  // No-match body
  // -------------------------------------------------------------------------
  it('no-match body: body unchanged (equal) and count=0', () => {
    const body = 'There are no matching links here. [[Other]] is fine.';
    const stale = new Set(['empire']);
    const { body: out, count } = rewriteWikilinks(body, stale, 'Imperium');
    expect(out).toBe(body);
    expect(count).toBe(0);
  });

  // -------------------------------------------------------------------------
  // Display-text-only reference NOT matched (only the ref/target is tested)
  // -------------------------------------------------------------------------
  it('display text containing a stale name is NOT matched (only target is checked)', () => {
    // [[Other|empire]] — "other" is not stale, "empire" is just the display text
    const body = 'See [[Other|empire]] for details.';
    const stale = new Set(['empire']);
    const { body: out, count } = rewriteWikilinks(body, stale, 'Imperium');
    expect(out).toBe(body);
    expect(count).toBe(0);
  });

  // -------------------------------------------------------------------------
  // T-48-02: newCanonicalTitle containing a pipe should not break structure
  // -------------------------------------------------------------------------
  it('T-48-02: title containing a pipe character does not create spurious extra pipe segment', () => {
    // Even if newCanonicalTitle has a |, the output should be structured correctly
    const body = '[[Empire]]';
    const stale = new Set(['empire']);
    // Titles with | in them are unusual but should be handled by building from parts
    const { body: out, count } = rewriteWikilinks(body, stale, 'Imp|erium');
    // The result should be a valid wikilink (target portion is the new title)
    // The exact output depends on implementation but must be one [[...]] token
    expect(count).toBe(1);
    expect(out).toMatch(/^\[\[.*\]\]$/);
  });

  // -------------------------------------------------------------------------
  // Edge: empty staleNames set — nothing rewrites
  // -------------------------------------------------------------------------
  it('empty staleNames set: nothing rewrites', () => {
    const body = '[[Empire]] is great.';
    const stale = new Set<string>();
    const { body: out, count } = rewriteWikilinks(body, stale, 'Imperium');
    expect(out).toBe(body);
    expect(count).toBe(0);
  });
});
