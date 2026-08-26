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

function splitFlowItems(value: string): string[] | null {
  const items: string[] = [];
  let start = 0;
  let quote: '"' | "'" | null = null;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (quote === '"' && character === '\\') {
      index += 1;
      continue;
    }
    if (quote === "'" && character === "'" && value[index + 1] === "'") {
      index += 1;
      continue;
    }
    if ((character === '"' || character === "'") && (quote === null || quote === character)) {
      quote = quote === null ? character : null;
      continue;
    }
    if (character === ',' && quote === null) {
      items.push(value.slice(start, index).trim());
      start = index + 1;
    }
  }
  if (quote !== null) return null;
  items.push(value.slice(start).trim());
  return items;
}

function parseScalar(value: string, allowComma = false): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('"')) {
    if (!trimmed.endsWith('"')) return null;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      return typeof parsed === 'string' ? parsed : null;
    } catch {
      return null;
    }
  }
  if (trimmed.startsWith("'")) {
    if (!trimmed.endsWith("'")) return null;
    const inner = trimmed.slice(1, -1);
    if (inner.includes('"')) return null;
    return inner.replace(/''/g, "'");
  }
  if (/["'\[\]{}]/.test(trimmed) || (!allowComma && trimmed.includes(','))) return null;
  return trimmed;
}

function parseTagValue(value: string): string[] | null {
  const trimmed = value.trim();
  if (!trimmed.startsWith('[') || !trimmed.endsWith(']')) return null;
  const inner = trimmed.slice(1, -1).trim();
  if (!inner) return [];
  const values = splitFlowItems(inner);
  if (!values || values.some((item) => !item)) return null;
  const parsed = values.map((item) => parseScalar(item));
  return parsed.every((item): item is string => item !== null) ? parsed : null;
}

function tagsFromRegion(region: FrontmatterRegion): { tags: string[]; diagnostics: MarkdownDiagnostic[] } {
  if (region.closeStart < 0) {
    return { tags: [], diagnostics: [{ severity: 'error', message: 'Frontmatter has no closing fence.' }] };
  }
  const lines = region.text.split(/\r?\n/).slice(1, -1);
  const tagLines = lines.filter((line) => /^tags\s*:/.test(line));
  if (tagLines.length > 1) {
    return { tags: [], diagnostics: [{ severity: 'error', message: 'Frontmatter contains duplicate tags fields.' }] };
  }
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const match = /^tags\s*:\s*(.*)$/.exec(line);
    if (!match) continue;
    const value = match[1].trim();
    if (!value) {
      const list: string[] = [];
      let next = index + 1;
      while (next < lines.length && /^\s+-\s+/.test(lines[next])) {
        const value = lines[next].replace(/^\s+-\s+/, '').trim();
        const parsed = parseScalar(value, true);
        if (parsed === null) return { tags: [], diagnostics: [{ severity: 'error', message: 'Frontmatter tags list contains an invalid scalar.' }] };
        list.push(parsed);
        next += 1;
      }
      if (next === index + 1) return { tags: [], diagnostics: [{ severity: 'error', message: 'Frontmatter tags must be a list.' }] };
      return { tags: list, diagnostics: [] };
    }
    const tags = parseTagValue(value);
    if (!tags) return { tags: [], diagnostics: [{ severity: 'error', message: 'Frontmatter tags must use [tag, ...] syntax.' }] };
    return { tags, diagnostics: [] };
  }
  return { tags: [], diagnostics: [] };
}

export function parseMarkdownFrontmatter(markdown: string): ParsedFrontmatter {
  const region = frontmatterRegion(markdown);
  if (!region) return { raw: null, tags: [], diagnostics: [] };
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
  const tagIndex = records.findIndex(({ content }) => /^tags\s*:/.test(content));
  let tagsStart = -1;
  let tagsEnd = -1;
  if (tagIndex >= 0) {
    tagsStart = records[tagIndex].start;
    tagsEnd = records[tagIndex].end;
    if (/^tags\s*:\s*$/.test(records[tagIndex].content)) {
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
  return /^[A-Za-z0-9_-]+$/.test(tag) ? tag : JSON.stringify(tag);
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
