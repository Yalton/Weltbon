/**
 * Locking test for PROXY-05 artifacts (plan 16.1-02 Wave-0 gap fix).
 *
 * The reverse-proxy snippets and smoke script were present and manually verified
 * in 14-VERIFICATION.md, but no Vitest spec asserted their presence and
 * non-emptiness — an accidental deletion would not be caught by the test suite.
 *
 * This spec closes that Wave-0 gap: every artifact that PROXY-05 requires must
 * exist on disk and contain at least one byte.
 *
 * Paths are resolved from the repo root (two levels above api/).
 * No DB needed. No network needed.
 */

import { describe, it, expect } from 'vitest';
import { statSync } from 'node:fs';
import { resolve } from 'node:path';

/** Resolve a repo-root-relative path from the api/ working directory. */
function repoPath(...segments: string[]): string {
  return resolve(process.cwd(), '..', ...segments);
}

describe('PROXY-05 artifacts', () => {
  it('Test 1: docs/reverse-proxy/Caddyfile.example exists and is non-empty', () => {
    const p = repoPath('docs', 'reverse-proxy', 'Caddyfile.example');
    const stat = statSync(p);
    expect(stat.size, `Caddyfile.example must be non-empty (found ${stat.size} bytes)`).toBeGreaterThan(0);
  });

  it('Test 2: docs/reverse-proxy/nginx.conf.example exists and is non-empty', () => {
    const p = repoPath('docs', 'reverse-proxy', 'nginx.conf.example');
    const stat = statSync(p);
    expect(stat.size, `nginx.conf.example must be non-empty (found ${stat.size} bytes)`).toBeGreaterThan(0);
  });

  it('Test 3: docs/reverse-proxy/README.md exists and is non-empty', () => {
    const p = repoPath('docs', 'reverse-proxy', 'README.md');
    const stat = statSync(p);
    expect(stat.size, `reverse-proxy README.md must be non-empty (found ${stat.size} bytes)`).toBeGreaterThan(0);
  });

  it('Test 4: scripts/proxy-smoke.sh exists and is non-empty', () => {
    const p = repoPath('scripts', 'proxy-smoke.sh');
    const stat = statSync(p);
    expect(stat.size, `proxy-smoke.sh must be non-empty (found ${stat.size} bytes)`).toBeGreaterThan(0);
  });
});
