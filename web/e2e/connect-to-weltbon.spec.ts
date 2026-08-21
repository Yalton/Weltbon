/**
 * ┌──────────────────────────────────────────────────────────────────────┐
 * │ THIS SPEC HAS NEVER BEEN EXECUTED.                                    │
 * └──────────────────────────────────────────────────────────────────────┘
 *
 * It was authored against the real code (ConnectToWeltbon.tsx,
 * useConnectToWeltbon.ts, UniverseList.tsx, SyncSettings.tsx, and the
 * api/src/routes/sync-client.ts handlers they call) but was never run, because
 * running it requires standing up the two-instance dev rig — starting Docker
 * containers and long-lived host processes — which is outside this task's
 * remit to trigger unasked. Do not report or imply that these three scenarios
 * pass; only that they are written and ready to run.
 *
 * TO RUN THIS SPEC:
 *
 *   1. Stand up the two-instance rig exactly as docs/sync-dev-rig.md
 *      describes: `docker compose -f docker-compose.dev.yml up -d --build`
 *      (instance B, :3001), instance A's API as a host `tsx watch` process
 *      on :3000, and `cd web && pnpm dev` for instance A's Vite dev server
 *      on :5173. A Chromium binary must be present at the path
 *      `PLAYWRIGHT_CHROMIUM_PATH` names, or at `/usr/bin/chromium`.
 *   2. From `web/`, run:
 *
 *        pnpm test:e2e:sync
 *
 *      (equivalently: `pnpm exec playwright test -c playwright.sync.config.ts`).
 *      `playwright.sync.config.ts`'s `testMatch` now lists this file
 *      alongside `sync.spec.ts`, so both run against the same rig in one
 *      invocation. To run only this file:
 *
 *        pnpm exec playwright test -c playwright.sync.config.ts e2e/connect-to-weltbon.spec.ts
 *
 *   `e2e/sync-global-setup.ts` probes instance A's API, instance A's Vite
 *   server, and instance B before anything runs, and refuses with the exact
 *   command to fix whichever is missing — it does not silently skip.
 *
 * WHAT THIS COVERS (Feature #42, Task 7 — OB-01..OB-04 end to end):
 *
 *   1. From an empty universe list, Connect with an address + credentials,
 *      and land in a populated universe (the whole one-button path: credential
 *      exchange → discovery → adopt → first sync → navigate to
 *      /universes/:id/entries showing content that was seeded only on the
 *      peer).
 *   2. A wrong password surfaces the credential error inline and leaves the
 *      user on the form — no navigation, nothing silently adopted.
 *   3. Connecting twice to the same instance (OB-03: idempotent registration)
 *      leaves exactly one row under Settings → Sync, not two.
 *
 * DATA. Unlike sync.spec.ts, this file does not read the shared
 * sync-seed.json that `sync-global-setup.ts` writes — that fixture's instance
 * A user already owns a universe, which is the opposite of what scenario 1
 * needs (an EMPTY universe list). Instead this file mints its own two
 * accounts directly against each instance's API in `beforeAll`, the same
 * "fixture data over the API, actions through the UI under test" split
 * sync.spec.ts itself documents and uses.
 *
 * COPY. Per ConnectToWeltbon.tsx's own rule, no assertion here should require
 * the word "remote", "link", "token", or "PAT" to appear on screen — the
 * flow-under-test's copy deliberately avoids them, and an assertion pinned to
 * one of those words would be testing a regression, not a feature.
 */

import { test, expect, type Browser, type BrowserContext, type Page } from '@playwright/test';
import {
  A_API,
  B_API,
  B_UI,
  PASSWORD,
  api,
  mintInvite,
  psqlA,
  psqlB,
} from './sync-seed';

test.describe.configure({ mode: 'serial' });

const stamp = Date.now();

/** Instance A: the account under test. Starts with ZERO universes. */
const aEmail = `connect-e2e-a-${stamp}@test.local`;

/** Instance B: the peer, seeded with exactly one universe + one entry. */
const bEmail = `connect-e2e-b-${stamp}@test.local`;
const universeName = `Connect E2E ${stamp}`;
const entryTitle = `Waystone of ${stamp}`;

let context: BrowserContext;
let page: Page;

async function login(p: Page, email: string) {
  await p.goto('/login');
  await p.fill('#email', email);
  await p.fill('#password', PASSWORD);
  await p.getByRole('button', { name: /sign in|log in/i }).click();
  await expect(p).not.toHaveURL(/\/login/, { timeout: 15_000 });
}

test.beforeAll(async ({ browser }: { browser: Browser }) => {
  // ─── Fixture data over the API (fast, and not what's under test) ────────
  await api(A_API, null, 'POST', '/auth/register', {
    email: aEmail,
    password: PASSWORD,
    displayName: `Connect E2E A ${stamp}`,
    inviteCode: mintInvite(psqlA, `connect-e2e-a-${stamp}`),
  });
  // Deliberately no universe created for aEmail — scenario 1 needs the
  // universe list genuinely empty, not merely unfiltered.

  const bReg = await api(B_API, null, 'POST', '/auth/register', {
    email: bEmail,
    password: PASSWORD,
    displayName: `Connect E2E B ${stamp}`,
    inviteCode: mintInvite(psqlB, `connect-e2e-b-${stamp}`),
  });
  const bToken = bReg.accessToken as string;
  const universe = await api(B_API, bToken, 'POST', '/universes', { name: universeName });
  await api(B_API, bToken, 'POST', `/universes/${universe.id}/entries`, {
    title: entryTitle,
    entryType: 'location',
    body: 'Seeded on instance B for the one-button connect e2e spec.',
  });

  // ─── Browser session, driving instance A's UI as aEmail ─────────────────
  context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  page = await context.newPage();
  page.on('pageerror', (e) => console.log('[browser pageerror]', e.message));
  await login(page, aEmail);
});

test.afterAll(async () => {
  await context?.close();
});

// ─── 1. Empty universe list → Connect → populated universe ──────────────────

test('1. connecting from an empty universe list lands in a populated universe', async () => {
  await page.goto('/universes');

  // Precondition: genuinely empty, not just unfiltered — this is the
  // EmptyState branch of UniverseList, not the grid.
  await expect(page.getByText(/start a universe/i)).toBeVisible();

  // The EmptyState's own "Connect to Weltbon" action (authMode === 'local'
  // gates it; the dev rig's instance A always runs in local auth mode).
  await page.getByRole('button', { name: 'Connect to Weltbon' }).click();

  await page.getByLabel('Address').fill(B_UI);
  await page.getByLabel('Email').fill(bEmail);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Connect' }).click();

  // Only one universe exists on B, so the flow skips the picker and goes
  // straight through adopt + first sync to /universes/:id/entries. The first
  // sync genuinely copies data across instances, hence the generous timeout —
  // matching sync.spec.ts's own first-sync budget.
  await expect(page).toHaveURL(/\/universes\/[^/]+\/entries$/, { timeout: 60_000 });

  // The payoff: content that was seeded ONLY on instance B is now visible on
  // instance A, with no separate "now sync" step the user had to find.
  await expect(page.getByText(entryTitle)).toBeVisible({ timeout: 30_000 });

  // No banned vocabulary leaked onto the populated screen either.
  const bodyText = (await page.locator('body').innerText()).toLowerCase();
  expect(bodyText).not.toMatch(/\bremote\b|\blink\b|\btoken\b|\bpat\b/);
});

// ─── 2. Wrong password stays on the form ─────────────────────────────────────

test('2. a wrong password shows the credential error and stays on the form', async () => {
  // The list is non-empty now (scenario 1 adopted a universe onto this same
  // account), so the entry point is the header's ghost button rather than the
  // EmptyState action — deliberately exercising the OTHER place the flow is
  // reachable from, per OB-05's "entry points" plural.
  await page.goto('/universes');
  await page.getByRole('button', { name: 'Connect to Weltbon' }).click();

  await page.getByLabel('Address').fill(B_UI);
  await page.getByLabel('Email').fill(bEmail);
  await page.getByLabel('Password').fill('definitely-the-wrong-password');
  await page.getByRole('button', { name: 'Connect' }).click();

  const alert = page.getByRole('alert');
  await expect(alert).toBeVisible({ timeout: 20_000 });
  // PeerAuthError's actual copy (api/src/services/sync/peer-auth.ts:92),
  // 'peer_credentials_rejected' — NOT the generic "Something went wrong"
  // fallback, which would mean the error path mis-attributed some other
  // failure as a rejected credential.
  await expect(alert).toContainText(/did not accept the email and password/i);
  await expect(alert).not.toContainText(/something went wrong/i);

  // Still on the credentials form, not bounced anywhere, and the address the
  // user typed is preserved so they don't have to retype it.
  await expect(page.getByLabel('Address')).toHaveValue(B_UI);
  await expect(page.getByLabel('Email')).toHaveValue(bEmail);
  // Password itself is cleared once `start()` resolves (ConnectToWeltbon.tsx's
  // documented password-lifetime rule) — asserting the field is empty is a
  // deliberate negative check for a credential lingering in the DOM.
  await expect(page.getByLabel('Password')).toHaveValue('');
  await expect(page).toHaveURL(/\/universes$/);
});

// ─── 3. Connecting twice yields one Settings → Sync entry, not two ──────────

test('3. connecting twice to the same instance leaves exactly one entry under Settings → Sync', async () => {
  // aEmail already connected to B once, in scenario 1. Do it again, same
  // address + credentials, from the same non-empty list's header button.
  await page.goto('/universes');
  await page.getByRole('button', { name: 'Connect to Weltbon' }).click();

  await page.getByLabel('Address').fill(B_UI);
  await page.getByLabel('Email').fill(bEmail);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Connect' }).click();

  // OB-04: re-adopting a universe already local to this account is treated as
  // success (the server's 409 'universe-already-local' is caught and resolved
  // to the existing link), so this completes the same way scenario 1 did.
  await expect(page).toHaveURL(/\/universes\/[^/]+\/entries$/, { timeout: 60_000 });

  // OB-03's payoff, verified where it is actually promised: the account-scoped
  // remotes table, not the universe-scoped links list (a second link to the
  // same remote would be a different, also-wrong bug this assertion would
  // miss if it looked at links instead).
  await page.goto('/settings/sync');
  const table = page.getByTestId('sync-remotes-table');
  await expect(table).toBeVisible();

  const rows = table.locator('tbody tr');
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText(new URL(B_UI).host);
});
