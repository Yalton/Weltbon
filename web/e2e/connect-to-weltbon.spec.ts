
import { test, expect, type Browser, type BrowserContext, type Page } from '@playwright/test';
import {
  A_API,
  B_API,
  B_UI,
  PASSWORD,
  api,
  mintInvite,
  psqlB,
} from './sync-seed';

test.describe.configure({ mode: 'serial' });

const stamp = Date.now();

/** Instance B: the peer, seeded with exactly one universe + one entry. This
 *  is the account whose email/password get typed into the Connect form. */
const bEmail = `connect-e2e-b-${stamp}@test.local`;
const universeName = `Connect E2E ${stamp}`;
const entryTitle = `Waystone of ${stamp}`;

let context: BrowserContext;
let page: Page;

/**
 * Set when instance A is not in local mode, which makes every test here skip
 * with that reason rather than fail. Not a throw: this spec and sync.spec.ts
 * need opposite modes on the same rig, so "the rig is set up for the other
 * spec" is a not-applicable, not a defect — and `pnpm test:e2e:sync` runs both.
 */
let wrongModeReason: string | null = null;

test.beforeAll(async ({ browser }: { browser: Browser }) => {
  // ─── Bail out early, with the actual remedy, if A isn't in local mode ────
  // Without this, a wrong-mode rig would instead hang on the "Connect to
  // Weltbon" button click below (it simply never renders in 'server' mode)
  // and the failure would say nothing about why.
  const runtime = (await (await fetch(`${A_API}/runtime`)).json()) as { authMode?: string };
  if (runtime.authMode !== 'local') {
    wrongModeReason =
      `Instance A must run with WELTBON_LOCAL_MODE=1 for this spec (its ` +
      `reported authMode is '${runtime.authMode}'). See this file's header ` +
      `comment for exactly what to change and why.`;
    // Seed nothing and open no browser context: every test below skips.
    return;
  }

  // ─── Fixture data over instance B's API only (fast, and not what's under
  //     test) — instance A needs no seeding, see the header's DATA note. ───
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

  // ─── Browser session on instance A. No login step: local mode has no
  //     credential to present — RuntimeProvider auto-authenticates the sole
  //     local user itself, before App() ever renders a route. ─────────────
  context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  page = await context.newPage();
  page.on('pageerror', (e) => console.log('[browser pageerror]', e.message));
});

// `test.skip(condition, reason)` belongs in beforeEach, not beforeAll —
// Playwright only honours it from a test body, a fixture, or a beforeEach.
test.beforeEach(() => {
  test.skip(wrongModeReason !== null, wrongModeReason ?? '');
});

test.afterAll(async () => {
  await context?.close();
});

// ─── 1. Empty universe list → Connect → populated universe ──────────────────

test('1. connecting from an empty universe list lands in a populated universe', async () => {
  await page.goto('/universes');

  // Precondition: genuinely empty, not just unfiltered — this is the
  // EmptyState branch of UniverseList, not the grid. (See the header's CAVEAT
  // note: only guaranteed on a db-a that has never run this spec before.)
  await expect(page.getByText(/start a universe/i)).toBeVisible();

  // The EmptyState's own "Connect to Weltbon" action (authMode === 'local'
  // gates it — asserted directly in beforeAll rather than assumed here).
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
  // The list is non-empty now (scenario 1 adopted a universe onto the sole
  // local user), so the entry point is the header's ghost button rather than
  // the EmptyState action — deliberately exercising the OTHER place the flow
  // is reachable from, per OB-05's "entry points" plural.
  await page.goto('/universes');
  await page.getByRole('button', { name: 'Connect to Weltbon' }).click();

  await page.getByLabel('Address').fill(B_UI);
  await page.getByLabel('Email').fill(bEmail);
  await page.getByLabel('Password').fill('definitely-the-wrong-password');
  await page.getByRole('button', { name: 'Connect' }).click();

  const alert = page.getByRole('alert');
  await expect(alert).toBeVisible({ timeout: 20_000 });
  // The connect flow's own copy for 'peer_credentials_rejected'
  // (web/src/lib/connectErrorCopy.ts) — NOT the server's own sentence, which
  // this pane must never print, and NOT the step-attributed fallback, which
  // would mean the error was mis-attributed rather than recognised.
  await expect(alert).toContainText(/email or password wasn't accepted by that instance/i);
  await expect(alert).not.toContainText(/something went wrong/i);
  // And it names the step, per the Definition of Done.
  await expect(alert).toContainText(/stopped while signing you in/i);

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
  // The sole local user already connected to B once, in scenario 1. Do it
  // again, same address + credentials, from the same non-empty list's header
  // button.
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
