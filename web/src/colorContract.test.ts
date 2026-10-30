import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = resolve(process.cwd(), 'src');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

describe('colour tokens', () => {
  it('never paints text in the same token as the surface behind it', () => {
    // The neutral-to-token cleanup once turned the graph tooltip into
    // `bg-ink-muted … text-ink-muted`: an opaque grey box with unreadable text.
    const offenders: string[] = [];
    for (const file of sourceFiles(SRC)) {
      for (const literal of readFileSync(file, 'utf8').match(/(["'`])(?:(?!\1)[^\n])*\1/g) ?? []) {
        for (const [, token] of literal.matchAll(/(?<![\w:-])bg-([a-z][\w-]*)/g)) {
          if (new RegExp(`(?<![\\w:-])text-${token}(?![\\w-])`).test(literal)) {
            offenders.push(`${relative(SRC, file)}: bg-${token} with text-${token}`);
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
