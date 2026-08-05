import { defineConfig } from '@playwright/test';

/**
 * E2E for the Plan F sync UI, run against INSTANCE A of the two-instance dev
 * rig (docs/sync-dev-rig.md): the Vite dev server on :5173, proxying /api to
 * instance A's host-run API on :3000, with instance B (the peer) at :3001.
 *
 * SEPARATE FROM `playwright.config.ts` ON PURPOSE. That config targets the
 * dockerized PRODUCTION stack at :3000 and its `webServer` block runs
 * `docker compose up -d` — pointing it at :5173 or letting it pick up this spec
 * would either start the wrong stack or run the share suite against a dev
 * server. The two suites also need different global setup (share seeds one
 * instance; sync seeds two). `playwright.config.ts` therefore ignores
 * `sync.spec.ts`, and this config runs only it.
 *
 * NO `webServer` BLOCK. Instance A's API and Vite are host processes, and
 * instance B is `docker-compose.dev.yml` — three things that Playwright cannot
 * usefully own. `sync-global-setup.ts` probes all three and fails with the
 * command to run instead.
 *
 * Timeouts are large because a first sync genuinely copies image bytes across
 * instances and the run is awaited inline in the UI (F-02/F-06).
 */
const CHROMIUM = process.env.PLAYWRIGHT_CHROMIUM_PATH || '/usr/bin/chromium';

export default defineConfig({
  testDir: './e2e',
  testMatch: 'sync.spec.ts',
  globalSetup: './e2e/sync-global-setup.ts',
  // One universe, one link, one lease — these tests are a sequence, not a set.
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  timeout: 180_000,
  expect: { timeout: 15_000 },
  reporter: [['list']],
  use: {
    baseURL: process.env.SYNC_E2E_A_UI || 'http://localhost:5173',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    viewport: { width: 1280, height: 800 },
    launchOptions: {
      executablePath: CHROMIUM,
      args: ['--no-sandbox', '--disable-gpu'],
    },
  },
  projects: [{ name: 'chromium' }],
});
