
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const repoRoot = path.resolve(__dirname, '../..');
const readme = fs.readFileSync(path.join(repoRoot, 'README.md'), 'utf8');
const workflowPath = path.join(repoRoot, '.github', 'workflows', 'publish-ghcr.yml');
const workflowContent = fs.readFileSync(workflowPath, 'utf8');
const composePath = path.join(repoRoot, 'docker-compose.yml');
const composeContent = fs.readFileSync(composePath, 'utf8');
const deployScriptPath = path.join(repoRoot, 'scripts', 'deploy.sh');

/**
 * The tag patterns under `on: push: tags:`.
 *
 * A line scanner rather than one regex. The regex version of this was wrong in
 * a way that mattered: it returned an empty list, and an empty list made the
 * "does not fire on milestone tags" assertion pass VACUOUSLY — `[].some(...)`
 * is false, so the test reported success while checking nothing at all. The
 * scanner is longer and obviously correct instead of short and quietly wrong.
 *
 * Deliberately not a YAML parse: `yaml` is not a declared dependency of api/,
 * and resolving it only works by walking up into the workspace root's store.
 * That works today and would break silently under a different pnpm layout — a
 * poor trade for reading four lines.
 */
function tagTriggerPatterns(yamlText: string): string[] {
  const lines = yamlText.split('\n');
  const patterns: string[] = [];

  let inPush = false;
  let inTags = false;

  for (const line of lines) {
    if (/^\s*#/.test(line) || line.trim() === '') continue;   // comments and blanks

    const indent = line.length - line.trimStart().length;

    if (/^\s*push:\s*$/.test(line)) { inPush = true; inTags = false; continue; }
    if (inPush && /^\s*tags:\s*$/.test(line)) { inTags = true; continue; }

    if (inTags) {
      const item = /^\s*-\s*['"]?([^'"#]+?)['"]?\s*$/.exec(line);
      if (item) { patterns.push(item[1]); continue; }
      // Any non-list, non-comment line ends the tags block.
      inTags = false;
      if (indent === 0) inPush = false;
    }
  }

  return patterns;
}

/**
 * Approximates GitHub's tag filter syntax closely enough for these assertions:
 * `*` is any run of non-`/` characters, `+` repeats the preceding element, a
 * bracket class is a character class, `?` is one character, and `.` is literal.
 *
 * Re-implementing a matcher inside a test is normally a smell. It earns its
 * place here because the alternative — asserting the pattern string verbatim —
 * is the exact brittleness that made this test go stale and then get merged red.
 */
function matchesTagPattern(pattern: string, tag: string): boolean {
  let re = '';
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === '[') {
      const close = pattern.indexOf(']', i);
      if (close === -1) { re += '\\['; continue; }
      re += pattern.slice(i, close + 1);
      i = close;
    } else if (ch === '*') re += '[^/]*';
    else if (ch === '+') re += '+';
    else if (ch === '?') re += '.';
    else re += ch.replace(/[.\\^$|()]/g, '\\$&');
  }
  return new RegExp(`^${re}$`).test(tag);
}

// ─────────────────────────────────────────────────────────────────────────────
// CONT-05: GHCR publish workflow file shape
// ─────────────────────────────────────────────────────────────────────────────

describe('CONT-05 — GHCR publish workflow (.github/workflows/publish-ghcr.yml)', () => {
  it('file exists', () => {
    expect(fs.existsSync(workflowPath)).toBe(true);
  });

    it('triggers on a release tag push', () => {
    // Pinned exactly. Every assertion below reads this list, and an empty list
    // would make the negative assertions pass while checking nothing.
    expect(tagTriggerPatterns(workflowContent)).toEqual(['v[0-9]+.[0-9]+.[0-9]+']);
  });

  it('covers three-part release tags', () => {
    const patterns = tagTriggerPatterns(workflowContent);
    expect(patterns.length).toBeGreaterThan(0);
    expect(patterns.some((p) => matchesTagPattern(p, 'v1.2.3'))).toBe(true);
    expect(patterns.some((p) => matchesTagPattern(p, 'v0.2.1'))).toBe(true);
  });

  it('does not fire on two-part milestone-archive tags', () => {
    const patterns = tagTriggerPatterns(workflowContent);
    expect(patterns.length).toBeGreaterThan(0);
    for (const milestone of ['v5.3', 'v1.0', 'v4.0']) {
      expect(
        patterns.some((p) => matchesTagPattern(p, milestone)),
        `A tag pattern in publish-ghcr.yml matches the milestone-archive tag ${milestone}. `
          + `Milestone tags are project-phase markers, not releases — publishing an image for `
          + `one moves \`latest\` to whatever the tree looked like at that moment. `
          + `Patterns found: ${JSON.stringify(patterns)}`,
      ).toBe(false);
    }
  });

  it('grants packages:write permission (uses GITHUB_TOKEN, not a PAT)', () => {
    expect(workflowContent).toMatch(/packages:\s*write/);
  });

  it('targets linux/amd64 platform', () => {
    expect(workflowContent).toMatch(/platforms:\s*linux\/amd64/);
  });

  it('authenticates to GHCR using secrets.GITHUB_TOKEN (no long-lived PAT)', () => {
    expect(workflowContent).toMatch(/password:\s*\$\{\{\s*secrets\.GITHUB_TOKEN\s*\}\}/);
    // Negative: no PAT secret reference
    expect(workflowContent).not.toMatch(/secrets\.GHCR_PAT/);
    expect(workflowContent).not.toMatch(/secrets\.CR_PAT/);
  });

  it('uses docker/build-push-action@v6', () => {
    expect(workflowContent).toMatch(/docker\/build-push-action@v6/);
  });

  it('docker-compose.yml has a commented image: switch for operators', () => {
    const composeContent = fs.readFileSync(
      path.join(repoRoot, 'docker-compose.yml'),
      'utf8',
    );
    // Commented image line referencing ghcr.io
    expect(composeContent).toMatch(/#\s*image:\s*ghcr\.io/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// OPS-05: README Self-Host (Docker) section with required subsections
// ─────────────────────────────────────────────────────────────────────────────

describe('OPS-05 — README Self-Host (Docker) section', () => {
  it('contains the ## Self-Host (Docker) top-level heading', () => {
    expect(readme).toMatch(/^## Self-Host \(Docker\)$/m);
  });

  it('contains the ### Prerequisites subsection', () => {
    expect(readme).toMatch(/^### Prerequisites$/m);
  });

  it('contains the ### `.env` Reference subsection', () => {
    expect(readme).toMatch(/^### `\.env` Reference$/m);
  });

  it('contains the ### Quickstart subsection', () => {
    expect(readme).toMatch(/^### Quickstart$/m);
  });

  it('contains the ### Verifying subsection', () => {
    // May appear in multiple sections; just assert at least one is present
    expect(readme).toMatch(/^### Verifying$/m);
  });

  it('contains the ### Updating subsection', () => {
    expect(readme).toMatch(/^### Updating$/m);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// OPS-06: README Backup section with cron line and sub-sections
// ─────────────────────────────────────────────────────────────────────────────

describe('OPS-06 — README Backup section', () => {
  it('contains the ## Backup top-level heading', () => {
    expect(readme).toMatch(/^## Backup$/m);
  });

  it('contains a pg_dump cron line using docker compose exec with the \\%F escape', () => {
    // The cron line may include a -f path flag; just assert the exec+pg_dump pair and \%F escape
    expect(readme).toMatch(/docker compose.*exec -T db pg_dump/);
    // The literal \%F must appear (backslash-percent-F) — not bare %F
    expect(readme).toMatch(/\\%F/);
  });

  it('contains a "What to back up" subsection', () => {
    expect(readme).toMatch(/### What to back up/);
  });

  it('contains a "What NOT to commit" subsection', () => {
    expect(readme).toMatch(/### What NOT to commit/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// OPS-07: api/package.json dev script auto-loads .env via tsx --env-file
// ─────────────────────────────────────────────────────────────────────────────

describe('OPS-07 — api/package.json dev script auto-loads .env', () => {
  const pkgPath = path.join(repoRoot, 'api', 'package.json');
  let pkg: { scripts?: Record<string, string> };

  it('api/package.json parses as valid JSON', () => {
    const raw = fs.readFileSync(pkgPath, 'utf8');
    expect(() => { pkg = JSON.parse(raw); }).not.toThrow();
  });

  it('dev script contains --env-file=../.env', () => {
    const raw = fs.readFileSync(pkgPath, 'utf8');
    pkg = JSON.parse(raw);
    expect(pkg.scripts?.dev).toMatch(/--env-file=\.\.\/\.env/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// OPS-08: README Self-Host (Bare Node) Chromium per-OS docs + CHROMIUM_PATH
// ─────────────────────────────────────────────────────────────────────────────

describe('OPS-08 — README Self-Host (Bare Node) Chromium documentation', () => {
  it('contains the ## Self-Host (Bare Node) top-level heading', () => {
    expect(readme).toMatch(/^## Self-Host \(Bare Node\)$/m);
  });

  it('contains Debian install section', () => {
    expect(readme).toMatch(/^### Debian/m);
  });

  it('contains Ubuntu install section', () => {
    expect(readme).toMatch(/^### Ubuntu/m);
  });

  it('contains macOS install section', () => {
    expect(readme).toMatch(/^### macOS$/m);
  });

  it('contains Windows install section', () => {
    expect(readme).toMatch(/^### Windows$/m);
  });

  it('mentions CHROMIUM_PATH for bare-Node PDF export configuration', () => {
    expect(readme).toMatch(/CHROMIUM_PATH/);
  });

  it('contains a ### Troubleshooting subsection (PDF-export troubleshooting checklist)', () => {
    expect(readme).toMatch(/^### Troubleshooting$/m);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Build identity reaches a locally-built image
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A self-hosted deploy compiles from a clone — `docker compose build app` — so
 * the version and commit that GET /api/version reports have to come in as build
 * args. Nothing in the container can derive them: the git history is not copied
 * into the runtime stage, and the Dockerfile's ARGs default to empty.
 *
 * When this was missing, prod ran for a full release cycle reporting
 * `"commit": null`, which is precisely the "which build is this?" question the
 * endpoint exists to answer.
 */
describe('local builds stamp the build identity', () => {
  it('docker-compose.yml passes the three build args through to the Dockerfile', () => {
    for (const arg of ['WELTBON_VERSION', 'WELTBON_COMMIT', 'WELTBON_BUILT_AT']) {
      expect(
        composeContent,
        `docker-compose.yml does not pass ${arg} as a build arg, so a locally built `
          + `image cannot report it at GET /api/version.`,
      ).toMatch(new RegExp(`${arg}:\\s*\\$\\{${arg}`));
    }
  });

  it('ships a deploy script that derives those values', () => {
    expect(
      fs.existsSync(deployScriptPath),
      'scripts/deploy.sh is the documented way to compute the build identity; '
        + 'compose cannot shell out to git on its own.',
    ).toBe(true);
  });

  /**
   * `node` is not on PATH over a non-interactive ssh session on the deploy box
   * (nvm-style install). A deploy script reaching for `node -p` to read the
   * version fails with `command not found`, and because it sits in an `&&`
   * chain the whole deploy short-circuits while still looking like it ran.
   * That cost one silent no-op deploy.
   */
  it('the deploy script does not depend on node being on PATH', () => {
    // Comments stripped first: the script explains at length WHY it avoids
    // node, and a naive scan for the word flags that explanation as the very
    // thing it warns against.
    const executable = fs
      .readFileSync(deployScriptPath, 'utf8')
      .split('\n')
      .filter((line) => !/^\s*#/.test(line))
      .join('\n');

    expect(
      /(^|[|&;(`$\s])node\s/.test(executable),
      'scripts/deploy.sh invokes node. It runs over non-interactive ssh where node '
        + 'is not on PATH; derive the version with sed instead.',
    ).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────

const SHARED_LLM_OPERATOR_GUIDANCE = [
  'SHARED_LLM_MONTHLY_COST_USD controls the per-recipient shared hosted-LLM',
  'budget for the current UTC calendar month. It defaults to 1.00 USD and must',
  'be a finite positive number. Shared connections support Anthropic and OpenAI',
  'API keys only; Ollama connections remain private to the desktop instance.',
  'Administrators must explicitly grant a user access, and that user must accept',
  'the provider disclosure before content can leave the instance.',
].join('\n');

describe('OPS-09 — README Shared LLM Connections documentation', () => {
  it('contains the ### Shared LLM Connections subsection', () => {
    expect(readme).toMatch(/^### Shared LLM Connections$/m);
  });

  it('contains the exact operator guidance text verbatim', () => {
    expect(readme).toContain(SHARED_LLM_OPERATOR_GUIDANCE);
  });

  /**
   * "Keep the existing LLM_KEY_ENCRYPTION_KEY requirement next to it"
   * (task-10-brief.md Step 3) is a placement instruction, not just a content
   * instruction — the guidance text could be pasted anywhere in the README
   * and a bare `toContain` check for both strings would pass. This isolates
   * the Shared LLM Connections section body (heading to next heading) and
   * requires BOTH strings inside that one section, so moving the guidance
   * text away from the LLM_KEY_ENCRYPTION_KEY mention fails this test even
   * though the mention still exists elsewhere in the README.
   */
  it('keeps the LLM_KEY_ENCRYPTION_KEY requirement next to the guidance text', () => {
    const lines = readme.split('\n');
    const headingLine = lines.findIndex((line) => line === '### Shared LLM Connections');
    expect(headingLine, 'Shared LLM Connections subsection not found').toBeGreaterThanOrEqual(0);
    // First heading line AFTER the section's own heading line, of any level.
    let nextHeadingLine = lines.length;
    for (let i = headingLine + 1; i < lines.length; i++) {
      if (/^#{1,6} /.test(lines[i])) { nextHeadingLine = i; break; }
    }
    const section = lines.slice(headingLine, nextHeadingLine).join('\n');

    expect(section).toContain(SHARED_LLM_OPERATOR_GUIDANCE);
    expect(section).toContain('LLM_KEY_ENCRYPTION_KEY');
  });

    it('documents the SHARED_LLM_MONTHLY_COST_USD default and boot validation in both env tables', () => {
    const rows = readme.split('\n').filter((line) => line.startsWith('| `SHARED_LLM_MONTHLY_COST_USD` |'));
    expect(
      rows.length,
      `expected exactly one SHARED_LLM_MONTHLY_COST_USD row in each of the two env tables ` +
        `(.env Reference and Environment Variables > Optional); found ${rows.length}`,
    ).toBe(2);
    for (const row of rows) {
      expect(row, `table row does not document "finite": ${row}`).toMatch(/finite/);
      expect(row, `table row does not document "positive": ${row}`).toMatch(/positive/);
      expect(row, `table row does not document the 1.00 default: ${row}`).toMatch(/1\.00/);
    }
  });

  it('documents the boot-time SHARED_LLM_MONTHLY_COST_USD validation error alongside the Startup Guard', () => {
    expect(readme).toMatch(/"SHARED_LLM_MONTHLY_COST_USD must be a finite positive number"/);
  });
});
