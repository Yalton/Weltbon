import { defineConfig } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');

/**
 * E2E smoke tests for the public share surface, run against the dockerized
 * production build at http://localhost:3000.
 *
 * These exist because every share-surface bug fixed in Phase 33 (the bare-array
 * render crash, the missing calendar/timelineWindow, the wikilink → /login
 * redirect, the WordPopover, and the d3 pin-click) was INVISIBLE to the jsdom
 * unit suite — only a real browser surfaced them. Playwright drives a real
 * browser so they can't regress silently again.
 *
 * Browser: uses the system Chromium (the same /usr/bin/chromium the app already
 * bundles for PDF export) via `executablePath`, so no ~150 MB Playwright browser
 * download is needed. Override with PLAYWRIGHT_CHROMIUM_PATH if yours lives
 * elsewhere.
 *
 * The stack must be running and rebuilt with the code under test:
 *   docker compose up -d --build
 * (the webServer block below will `up -d` an already-built image if it's down,
 *  but it will NOT rebuild — rebuild yourself after changing app source.)
 */
const CHROMIUM = process.env.PLAYWRIGHT_CHROMIUM_PATH || '/usr/bin/chromium';

export default defineConfig({
  testDir: './e2e',
  globalSetup: './e2e/global-setup.ts',
  globalTeardown: './e2e/global-teardown.ts',
  // Seeding + the single shared universe mean tests must not race each other.
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  timeout: 30_000,
  expect: { timeout: 7_000 },
  reporter: process.env.CI ? 'list' : [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: 'http://localhost:3000',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    viewport: { width: 1280, height: 800 },
    launchOptions: {
      executablePath: CHROMIUM,
      args: ['--no-sandbox', '--disable-gpu'],
    },
  },
  projects: [{ name: 'chromium' }],
  webServer: {
    command: 'docker compose up -d',
    cwd: repoRoot,
    url: 'http://localhost:3000',
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
