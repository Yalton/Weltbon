/**
 * ┌──────────────────────────────────────────────────────────────────────┐
 * │ THIS SPEC HAS NEVER BEEN EXECUTED.                                    │
 * └──────────────────────────────────────────────────────────────────────┘
 *
 * It was authored against the real code (ConnectToWeltbon.tsx,
 * useConnectToWeltbon.ts, UniverseList.tsx, SyncSettings.tsx, RuntimeProvider.tsx,
 * and the api/src/routes/{runtime,auth,sync-client}.ts handlers they call) but
 * was never run, because running it requires standing up the two-instance dev
 * rig — starting Docker containers and long-lived host processes — which is
 * outside this task's remit to trigger unasked. Do not report or imply that
 * these three scenarios pass; only that they are written and ready to run.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * THIS SPEC NEEDS A VARIATION ON THE STANDARD RIG: INSTANCE A IN LOCAL MODE.
 * ══════════════════════════════════════════════════════════════════════════
 *
 * docs/sync-dev-rig.md's default setup runs instance A in 'server' auth mode
 * (the mode sync.spec.ts's `login()` needs — a real per-account email+password
 * sign-in via /login). This spec needs the OPPOSITE of that on instance A,
 * because "Connect to Weltbon" is the DESKTOP's entry point, and the desktop
 * never has a login screen at all:
 *
 *   - `ConnectToWeltbon`'s "Connect to Weltbon" button (`UniverseList.tsx:89-93,
 *     137-139`) only renders when `authMode === 'local'`.
 *   - `authMode` comes from `GET /api/runtime`, which reports `'local'` only
 *     when the API process has `WELTBON_LOCAL_MODE=1` set
 *     (`api/src/routes/runtime.ts:7`, `api/src/config.ts:148`).
 *   - In local mode there is no registration and no `/login` form at all:
 *     `RuntimeProvider` (`web/src/runtime/RuntimeProvider.tsx:67-79`) POSTs
 *     `/api/auth/local-session` itself, on mount, and that route
 *     (`api/src/routes/auth.ts:263-489`) mints a session for the sole local
 *     user via `ensureLocalUser` with NO credential presented — gated on the
 *     env flag plus a loopback-only check on the real TCP peer. `App.tsx:44`
 *     additionally redirects `/login` itself to `/universes` whenever
 *     `authMode === 'local'`, so there is no form to visit even by URL.
 *
 * So: THE ACCOUNT THIS SPEC TYPES INTO THE CONNECT FORM BELONGS TO INSTANCE B,
 * NOT INSTANCE A. Instance A is the desktop being tested; instance B is the
 * hosted peer the desktop connects to. The email/password typed into
 * `ConnectToWeltbon`'s form are sent by instance A's own API, server-side, to
 * instance B's `/api/auth/login` (`mintPatFromCredentials`,
 * `api/src/services/sync/peer-auth.ts`) — the browser itself never talks to B
 * directly. The base URL typed into the form is instance B's origin.
 *
 * TO RUN THIS SPEC (in addition to docs/sync-dev-rig.md's normal steps):
 *
 *   1. Start instance B exactly as the rig doc describes — normal 'server'
 *      mode, unchanged: `docker compose -f docker-compose.dev.yml up -d --build`.
 *   2. Start instance A's API with `WELTBON_LOCAL_MODE=1` set on that process
 *      — e.g. added as a line in `.env.dev-a` (picked up by
 *      `--env-file=../.env.dev-a`) or exported in the shell before the `tsx
 *      watch` invocation, the same way the rig doc already handles
 *      `DATABASE_URL`/`UPLOADS_DIR`/etc. This is NOT instance A's default dev
 *      rig configuration — `.env.dev-a.example` does not set it.
 *   3. `cd web && pnpm dev` for instance A's Vite dev server on :5173, same
 *      as always. A Chromium binary must be present at the path
 *      `PLAYWRIGHT_CHROMIUM_PATH` names, or at `/usr/bin/chromium`.
 *   4. From `web/`, run just this file:
 *
 *        pnpm exec playwright test -c playwright.sync.config.ts e2e/connect-to-weltbon.spec.ts
 *
 * DO NOT run `pnpm test:e2e:sync` unqualified expecting both spec files to
 * pass in one invocation. `playwright.sync.config.ts`'s `testMatch` lists
 * both `sync.spec.ts` and this file so each is DISCOVERABLE in that config,
 * but the two specs need instance A in OPPOSITE auth modes — sync.spec.ts's
 * `login()` requires 'server' mode and will fail outright against a
 * local-mode A (no `/login` form to fill in; `App.tsx` redirects it away).
 * Run them as two separate invocations against instance A restarted in the
 * matching mode each time; `sync-global-setup.ts` reruns fixture setup for
 * both, so nothing else about the rig needs to change between them.
 *
 * `e2e/sync-global-setup.ts` probes instance A's API, instance A's Vite
 * server, and instance B before anything runs, and refuses with the exact
 * command to fix whichever is missing — but it does NOT check instance A's
 * auth mode, so a misconfigured local-mode flag will surface here instead, as
 * the `beforeAll` runtime-mode assertion below, not as a silent hang.
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
 * DATA. This file does not read the shared sync-seed.json that
 * sync-global-setup.ts writes — that fixture's instance-A user is a
 * 'server'-mode account that would not even exist under local mode (the sole
 * local user is created on demand by `ensureLocalUser`, not by registration).
 * Only instance B needs a seeded account + universe here, minted directly
 * against B's API in `beforeAll` — the same "fixture data over the API,
 * actions through the real UI" split sync.spec.ts itself documents and uses.
 * Instance A needs NO seeding at all: a freshly migrated db-a's sole local
 * user genuinely has zero universes, which is scenario 1's precondition.
 *
 * CAVEAT — SHARED LOCAL USER ACROSS RUNS. Unlike instance B's fixtures (a
 * fresh, uniquely-stamped email per run), instance A in local mode always
 * resolves to the SAME sole local user (`ensureLocalUser` is an upsert, not a
 * create). Scenario 1's "empty universe list" precondition is therefore only
 * guaranteed true on a db-a that has never been used for a local-mode run
 * before (a fresh `docker compose ... up -d` + fresh migrations, or a db-a
 * whose test-created universes have been manually cleared). Re-running this
 * spec against a db-a that already carries this spec's own earlier universes
 * will fail scenario 1's empty-state assertion — that is expected, not a spec
 * bug, and is exactly why the `beforeAll` below does not attempt to detect or
 * paper over it.
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

test.beforeAll(async ({ browser }: { browser: Browser }) => {
  // ─── Fail fast, with the actual remedy, if A isn't in local mode ────────
  // Without this, a misconfigured rig would instead hang on the "Connect to
  // Weltbon" button click below (it simply never renders in 'server' mode)
  // and the failure would say nothing about why.
  const runtime = (await (await fetch(`${A_API}/runtime`)).json()) as { authMode?: string };
  if (runtime.authMode !== 'local') {
    throw new Error(
      `Instance A must run with WELTBON_LOCAL_MODE=1 for this spec (its ` +
        `reported authMode is '${runtime.authMode}'). See this file's header ` +
        `comment for exactly what to change and why.`,
    );
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
