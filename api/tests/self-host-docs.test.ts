/**
 * Phase 15 Nyquist locks — self-host documentation and CI workflow file-shape assertions.
 *
 * These tests guard CONT-05, OPS-05, OPS-06, OPS-07, and OPS-08 against accidental deletion
 * or modification of the key operator-facing artefacts (README sections, workflow YAML, and
 * api/package.json dev script). No Postgres connection required — all assertions are
 * file-system reads.
 *
 * Companion to: project documentation
 * Do NOT extend this file with unrelated requirements. Phase 15 gaps only.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const repoRoot = path.resolve(__dirname, '../..');
const readme = fs.readFileSync(path.join(repoRoot, 'README.md'), 'utf8');
const workflowPath = path.join(repoRoot, '.github', 'workflows', 'publish-ghcr.yml');
const workflowContent = fs.readFileSync(workflowPath, 'utf8');

// ─────────────────────────────────────────────────────────────────────────────
// CONT-05: GHCR publish workflow file shape
// ─────────────────────────────────────────────────────────────────────────────

describe('CONT-05 — GHCR publish workflow (.github/workflows/publish-ghcr.yml)', () => {
  it('file exists', () => {
    expect(fs.existsSync(workflowPath)).toBe(true);
  });

  it('contains a v* tag push trigger', () => {
    expect(workflowContent).toMatch(/on:\s*\n\s+push:\s*\n\s+tags:\s*\n\s+- ['"]?v\*/m);
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
