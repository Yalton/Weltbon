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

type FrontmatterRegion = { start: number; end: number; closeStart: number; text: string };

function frontmatterRegion(markdown: string): FrontmatterRegion | null {
  if (!markdown.startsWith('---')) return null;
  const openingEnd = markdown.indexOf('\n');
  if (openingEnd < 0 || !/^---\r?$/.test(markdown.slice(0, openingEnd))) return null;
  const close = /(?:^|\n)---\r?(?:\n|$)/g;
  close.lastIndex = openingEnd + 1;
  const match = close.exec(markdown);
  if (!match) return { start: 0, end: markdown.length, closeStart: -1, text: markdown };
  const closeStart = match[0].startsWith('\n') ? match.index + 1 : match.index;
  const end = match.index + match[0].length - (match[0].endsWith('\n') ? 1 : 0);
  return { start: 0, end, closeStart, text: markdown.slice(0, end) };
}

function parseTagValue(value: string): string[] | null {
  const trimmed = value.trim();
  if (!trimmed) return [];
  if (!trimmed.startsWith('[') || !trimmed.endsWith(']')) return null;
  const inner = trimmed.slice(1, -1).trim();
  if (!inner) return [];
  const values = inner.split(',').map((item) => item.trim());
  if (values.some((item) => !item || (item.startsWith('"') && !item.endsWith('"')))) return null;
  return values.map((item) => item.replace(/^("|')|("|')$/g, ''));
}

function tagsFromRegion(region: FrontmatterRegion): { tags: string[]; diagnostics: MarkdownDiagnostic[] } {
  if (region.closeStart < 0) {
    return { tags: [], diagnostics: [{ severity: 'error', message: 'Frontmatter has no closing fence.' }] };
  }
  const lines = region.text.split(/\r?\n/).slice(1, -1);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const match = /^tags\s*:\s*(.*)$/.exec(line);
    if (!match) continue;
    const value = match[1].trim();
    if (!value) {
      const list: string[] = [];
      let next = index + 1;
      while (next < lines.length && /^\s+-\s+/.test(lines[next])) {
        list.push(lines[next].replace(/^\s+-\s+/, '').trim().replace(/^("|')|("|')$/g, ''));
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
  if (!region || region.closeStart < 0) return markdown;
  if (tagsFromRegion(region).diagnostics.length > 0) return markdown;
  const lines = region.text.split(/(\r?\n)/);
  let offset = 0;
  let tagsStart = -1;
  let tagsEnd = -1;
  for (let index = 0; index < lines.length; index += 2) {
    const line = lines[index];
    if (/^tags\s*:/.test(line)) {
      tagsStart = offset;
      tagsEnd = offset + line.length;
      if (line.replace(/^tags\s*:\s*/, '') === '') {
        let next = index + 2;
        while (next < lines.length && /^\s+-\s+/.test(lines[next])) {
          tagsEnd += lines[next - 1].length + lines[next].length;
          next += 2;
        }
      }
      break;
    }
    offset += line.length + (lines[index + 1]?.length ?? 0);
  }
  const serialized = `tags: [${tags.join(', ')}]`;
  let updated: string;
  if (tagsStart >= 0) updated = region.text.slice(0, tagsStart) + serialized + region.text.slice(tagsEnd);
  else updated = region.text.slice(0, region.closeStart) + serialized + (region.text[region.closeStart - 1] === '\n' ? '' : '\n') + region.text.slice(region.closeStart);
  return updated + markdown.slice(region.end);
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
