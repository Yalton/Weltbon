import { isAlias, isMap, isScalar, isSeq, parseDocument, type YAMLMap } from 'yaml';

export type MarkdownDiagnostic = {
  message: string;
  severity: 'warning' | 'error';
};

export type ParsedFrontmatter = {
  /** The original document-start block, including its opening and closing fences. */
  raw: string | null;
  tags: string[];
  diagnostics: MarkdownDiagnostic[];
};

export type MarkdownHeading = {
  level: number;
  text: string;
  slug: string;
};

type FrontmatterRegion = { start: number; end: number; closeStart: number; text: string; eol: string };

function frontmatterRegion(markdown: string): FrontmatterRegion | null {
  if (!markdown.startsWith('---')) return null;
  const openingEnd = markdown.indexOf('\n');
  if (openingEnd < 0 || !/^---\r?$/.test(markdown.slice(0, openingEnd))) return null;
  const eol = markdown.slice(openingEnd - 1, openingEnd) === '\r' ? '\r\n' : '\n';
  let lineStart = openingEnd + 1;
  while (lineStart <= markdown.length) {
    const lineEnd = markdown.indexOf('\n', lineStart);
    const end = lineEnd < 0 ? markdown.length : lineEnd;
    const contentEnd = end > lineStart && markdown[end - 1] === '\r' ? end - 1 : end;
    if (markdown.slice(lineStart, contentEnd) === '---') {
      return { start: 0, end: contentEnd, closeStart: lineStart, text: markdown.slice(0, contentEnd), eol };
    }
    if (lineEnd < 0) break;
    lineStart = lineEnd + 1;
  }
  return { start: 0, end: markdown.length, closeStart: -1, text: markdown, eol };
}

function tagsFromRegion(region: FrontmatterRegion): { tags: string[]; diagnostics: MarkdownDiagnostic[] } {
  if (region.closeStart < 0) {
    return { tags: [], diagnostics: [{ severity: 'error', message: 'Frontmatter has no closing fence.' }] };
  }
  const lines = region.text.split(/\r?\n/).slice(1, -1);
  const analysis = parseFrontmatterYaml(region);
  const yaml = frontmatterYaml(region);
  const root = analysis.document?.contents;
  if (root !== null && root !== undefined && !isMap(root)) {
    return {
      tags: [],
      diagnostics: [analysis.diagnostic ?? { severity: 'error', message: 'Frontmatter root must be a mapping.' }],
    };
  }

  const astTags = isMap(root) ? tagsFromYamlMap(root, yaml) : { tags: [], diagnostic: null };
  if (astTags.diagnostic) {
    return { tags: [], diagnostics: [analysis.diagnostic ?? astTags.diagnostic] };
  }
  if (analysis.diagnostic) {
    return { tags: isolatedTagsFromLines(lines), diagnostics: [analysis.diagnostic] };
  }
  return { tags: astTags.tags, diagnostics: [] };
}

type FrontmatterYamlAnalysis = {
  document: ReturnType<typeof parseDocument> | null;
  diagnostic: MarkdownDiagnostic | null;
};

function parseFrontmatterYaml(region: FrontmatterRegion): FrontmatterYamlAnalysis {
  const yaml = frontmatterYaml(region);
  try {
    const document = parseDocument(yaml, { strict: true });
    const parserIssue = document.errors[0] ?? document.warnings[0];
    if (parserIssue) {
      return {
        document,
        diagnostic: { severity: 'error', message: `Frontmatter YAML: ${parserIssue.message.trim()}` },
      };
    }
    try {
      // Parsing is used only to force validation of aliases and other deferred errors.
      // The returned JS value is deliberately discarded so raw YAML stays lossless.
      document.toJS();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'The YAML value could not be resolved.';
      return { document, diagnostic: { severity: 'error', message: `Frontmatter YAML: ${message}` } };
    }
    return { document, diagnostic: null };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'The YAML document could not be parsed.';
    return { document: null, diagnostic: { severity: 'error', message: `Frontmatter YAML: ${message}` } };
  }
}

type TagsNodeResult = { tags: string[]; diagnostic: MarkdownDiagnostic | null };

function frontmatterYaml(region: FrontmatterRegion): string {
  const openingEnd = region.text.indexOf('\n');
  return region.text.slice(openingEnd + 1, region.closeStart);
}

function canonicalTagsKeyLine(key: unknown, source: string): string | null {
  if (!isScalar(key) || key.source !== 'tags' || !key.range) return null;
  const [start, end] = key.range;
  const lineStart = source.lastIndexOf('\n', start - 1) + 1;
  if (start !== lineStart || source.slice(start, end) !== 'tags') return null;
  const lineEnd = source.indexOf('\n', start);
  const contentEnd = lineEnd < 0 ? source.length : lineEnd;
  const line = source.slice(lineStart, contentEnd).replace(/\r$/, '');
  return /^tags:/.test(line) ? line : null;
}

function hasMultilineSource(node: { range?: [number, number, number] | null }, source: string): boolean {
  const range = node.range;
  return !range || /[\r\n]/.test(source.slice(range[0], range[1]));
}

function hasComment(node: { comment?: string | null; commentBefore?: string | null }): boolean {
  return node.comment !== undefined && node.comment !== null
    || node.commentBefore !== undefined && node.commentBefore !== null;
}

function tagsFromYamlMap(root: YAMLMap, source: string): TagsNodeResult {
  const pairs = root.items.filter((pair) => isScalar(pair.key) && pair.key.value === 'tags');
  if (pairs.length === 0) return { tags: [], diagnostic: null };
  if (pairs.length > 1) return { tags: [], diagnostic: { severity: 'error', message: 'Frontmatter contains duplicate tags fields.' } };
  const keyLine = canonicalTagsKeyLine(pairs[0].key, source);
  if (keyLine === null) {
    return { tags: [], diagnostic: { severity: 'error', message: 'Frontmatter tags key must be an unquoted, column-zero field.' } };
  }

  const node = pairs[0].value;
  if (!isSeq(node)) return { tags: [], diagnostic: { severity: 'error', message: 'Frontmatter tags must be a YAML sequence.' } };
  if (node.anchor || node.tag) {
    return { tags: [], diagnostic: { severity: 'error', message: 'Frontmatter tags sequence cannot be anchored or tagged.' } };
  }
  if (!node.flow && !/^tags:\s*$/.test(keyLine)) {
    return { tags: [], diagnostic: { severity: 'error', message: 'Frontmatter block tags must use a comment-free tags header.' } };
  }
  if (node.flow && hasMultilineSource(node, source)) {
    return { tags: [], diagnostic: { severity: 'error', message: 'Frontmatter tags flow sequence must remain on one line.' } };
  }
  if (hasComment(node)) {
    return { tags: [], diagnostic: { severity: 'error', message: 'Frontmatter tags cannot contain comments.' } };
  }
  if (!node.flow && node.spaceBefore) {
    return { tags: [], diagnostic: { severity: 'error', message: 'Frontmatter block tags cannot contain blank lines.' } };
  }
  const tags: string[] = [];
  for (const item of node.items) {
    if (isAlias(item)) return { tags: [], diagnostic: { severity: 'error', message: 'Frontmatter tags cannot contain aliases.' } };
    if (!isScalar(item) || item.anchor || item.tag) {
      return { tags: [], diagnostic: { severity: 'error', message: 'Frontmatter tags must contain only unaliased scalar values.' } };
    }
    if (!node.flow && (hasComment(item) || item.spaceBefore)) {
      return { tags: [], diagnostic: { severity: 'error', message: 'Frontmatter block tags cannot contain comments or blank lines.' } };
    }
    if (hasMultilineSource(item, source)) {
      return { tags: [], diagnostic: { severity: 'error', message: 'Frontmatter tags must contain single-line scalar values.' } };
    }
    if (item.type === 'BLOCK_LITERAL' || item.type === 'BLOCK_FOLDED' || (typeof item.value === 'string' && /[\r\n]/.test(item.value))) {
      return { tags: [], diagnostic: { severity: 'error', message: 'Frontmatter tags cannot contain multiline scalar values.' } };
    }
    if (typeof item.value !== 'string') {
      return { tags: [], diagnostic: { severity: 'error', message: 'Frontmatter tags must contain scalar string values.' } };
    }
    tags.push(item.value);
  }
  return { tags, diagnostic: null };
}

function isolatedTagsFromLines(lines: string[]): string[] {
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^tags:\s*(.*)$/.exec(lines[index]);
    if (!match) continue;
    const isolated = [lines[index]];
    if (!match[1].trim()) {
      let next = index + 1;
      while (next < lines.length && /^\s+-\s+/.test(lines[next])) {
        isolated.push(lines[next]);
        next += 1;
      }
    }
    try {
      const document = parseDocument(isolated.join('\n'), { strict: true });
      if (document.errors.length > 0 || document.warnings.length > 0) return [];
      document.toJS();
      const root = document.contents;
      if (!isMap(root)) return [];
      const tags = tagsFromYamlMap(root, isolated.join('\n'));
      return tags.diagnostic ? [] : tags.tags;
    } catch {
      return [];
    }
  }
  return [];
}

export function parseMarkdownFrontmatter(markdown: string): ParsedFrontmatter {
  const region = frontmatterRegion(markdown);
  if (!region) {
    const cannotPrepend = markdown.startsWith('\n') || markdown.startsWith('\r') || markdown.startsWith('---');
    return {
      raw: null,
      tags: [],
      diagnostics: cannotPrepend
        ? [{ severity: 'error', message: 'Document cannot safely receive frontmatter from its current prefix.' }]
        : [],
    };
  }
  const parsed = tagsFromRegion(region);
  return { raw: parsed.diagnostics.length > 0 ? markdown : region.text, ...parsed };
}

export function replaceSupportedFrontmatterTags(markdown: string, tags: string[]): string {
  const region = frontmatterRegion(markdown);
  if (!region) {
    if (tags.length === 0 || markdown.startsWith('---') || markdown.startsWith('\n') || markdown.startsWith('\r')) return markdown;
    const eol = markdown.includes('\r\n') ? '\r\n' : '\n';
    const serializedTags = tags.map(serializeTag);
    if (serializedTags.some((tag) => tag === null)) return markdown;
    return `---${eol}tags: [${serializedTags.join(', ')}]${eol}---${markdown.length > 0 ? eol : ''}${markdown}`;
  }
  if (region.closeStart < 0) return markdown;
  if (tagsFromRegion(region).diagnostics.length > 0) return markdown;
  const serializedTags = tags.map(serializeTag);
  if (serializedTags.some((tag) => tag === null)) return markdown;
  const serialized = `tags: [${serializedTags.join(', ')}]`;
  const records = lineRecords(region.text);
  const tagIndex = records.findIndex(({ content }) => /^tags:/.test(content));
  let tagsStart = -1;
  let tagsEnd = -1;
  if (tagIndex >= 0) {
    tagsStart = records[tagIndex].start;
    tagsEnd = records[tagIndex].end;
    if (/^tags:\s*$/.test(records[tagIndex].content)) {
      let next = tagIndex + 1;
      while (next < records.length - 1 && /^\s+-\s+/.test(records[next].content)) {
        tagsEnd = records[next].end;
        next += 1;
      }
    }
  }
  let updated: string;
  if (tagsStart >= 0) updated = region.text.slice(0, tagsStart) + serialized + region.text.slice(tagsEnd);
  else {
    updated = region.text.slice(0, region.closeStart) + serialized + region.eol + region.text.slice(region.closeStart);
  }
  return updated + markdown.slice(region.end);
}

type FrontmatterLine = { content: string; start: number; end: number; eol: string };

function lineRecords(text: string): FrontmatterLine[] {
  const records: FrontmatterLine[] = [];
  let start = 0;
  while (start < text.length) {
    const newline = text.indexOf('\n', start);
    if (newline < 0) {
      records.push({ content: text.slice(start), start, end: text.length, eol: '' });
      break;
    }
    const contentEnd = newline > start && text[newline - 1] === '\r' ? newline - 1 : newline;
    records.push({ content: text.slice(start, contentEnd), start, end: contentEnd, eol: text.slice(contentEnd, newline + 1) });
    start = newline + 1;
  }
  return records;
}

function serializeTag(tag: string): string | null {
  if (tag.includes('\n') || tag.includes('\r')) return null;
  const lower = tag.toLowerCase();
  const normalizedNumeric = tag.replaceAll('_', '');
  const implicit = lower === 'true' || lower === 'false' || lower === 'null'
    || lower === 'yes' || lower === 'no' || lower === 'on' || lower === 'off'
    || tag === '-'
    || (/^[+\-0-9.eE_]+$/.test(tag) && /^[+-]?(?:(?:\d+)(?:\.\d+)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(normalizedNumeric))
    || /^0[xob][0-9a-f]+$/i.test(tag)
    || /^[-+]?\.(?:inf|nan)$/i.test(tag)
    || /^\d{4}-\d{1,2}-\d{1,2}(?:[Tt ]\d{1,2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:[Zz]|[+-]\d{1,2}(?::?\d{2})?)?)?$/.test(tag);
  return /^[A-Za-z0-9_-]+$/.test(tag) && !implicit ? tag : JSON.stringify(tag);
}

function slugify(text: string): string {
  return text.toLowerCase().trim().replace(/\{#([^}]+)\}\s*$/, '').replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '');
}

export function collectMarkdownHeadings(markdown: string): MarkdownHeading[] {
  const region = frontmatterRegion(markdown);
  const body = region && region.closeStart >= 0 ? markdown.slice(region.end).replace(/^\r?\n/, '') : markdown;
  const headings: MarkdownHeading[] = [];
  let fenced = false;
  for (const line of body.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) { fenced = !fenced; continue; }
    if (fenced) continue;
    const match = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (!match) continue;
    const text = match[2].trim();
    const custom = /\{#([^}]+)\}\s*$/.exec(text);
    headings.push({ level: match[1].length, text: custom ? text.slice(0, custom.index).trim() : text, slug: custom?.[1] ?? slugify(text) });
  }
  return headings;
}
