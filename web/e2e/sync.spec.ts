/**
 * Plan F, Task 5 — the sync UI in a real browser, against two real instances.
 *
 * WHY THIS FILE EXISTS. Tasks 1–4 shipped with 1355 passing jsdom tests, and
 * jsdom does no layout and no hit-testing: clipping, overlap, collapsed
 * containers, pointer-events, z-index and focus are all invisible to it. It
 * also cannot run a real cross-instance sync, so every assertion those tests
 * make about a run is an assertion about a mock. `share.spec.ts` exists for the
 * same reason — every share-surface bug in Phase 33 was invisible to the unit
 * suite and only a real browser surfaced them.
 *
 * The rig is docs/sync-dev-rig.md. Instance A (this UI) is Vite on :5173 over a
 * host API on :3000; instance B (the peer) is the container on :3001. Fixture
 * DATA is created over the API because that is faster and less brittle; every
 * sync ACTION is driven through A's UI, because the UI is what is under test.
 *
 * Run with:
 *   pnpm exec playwright test -c playwright.sync.config.ts
 */

import { test, expect, type Browser, type BrowserContext, type Page, type Locator } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  A_API,
  B_API,
  B_UI,
  PASSWORD,
  SYNC_SEED_FILE,
  TINY_PNG,
  api,
  psqlA,
  type SyncSeed,
} from './sync-seed';

const seed: SyncSeed = JSON.parse(readFileSync(SYNC_SEED_FILE, 'utf8'));
const SHOTS = resolve(dirname(fileURLToPath(import.meta.url)), 'screenshots');
mkdirSync(SHOTS, { recursive: true });

/** The peer's address, and the dead one scenario 2 points at. */
const PEER_URL = B_UI;
const DEAD_URL = 'http://localhost:9999';

let browserRef: Browser;
let context: BrowserContext;
let page: Page;
let shotSeq = 0;

/** A JWT for A's API. Re-minted per call — the run outlives an access token. */
async function aToken(): Promise<string> {
  const res = await api(A_API, null, 'POST', '/auth/login', {
    email: seed.aEmail,
    password: PASSWORD,
  });
  return res.accessToken as string;
}

async function bToken(): Promise<string> {
  const res = await api(B_API, null, 'POST', '/auth/login', {
    email: seed.bEmail,
    password: PASSWORD,
  });
  return res.accessToken as string;
}

async function shot(name: string) {
  shotSeq += 1;
  await page.screenshot({
    path: resolve(SHOTS, `${String(shotSeq).padStart(2, '0')}-${name}.png`),
    fullPage: true,
  });
}

/**
 * The single layout assertion jsdom structurally cannot make: does the document
 * scroll sideways? Every clipped-long-error and overflowing-badge defect this
 * task was told to hunt for shows up here or in `assertReadable` below.
 */
async function assertNoPageOverflow(where: string) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow, `horizontal page overflow at ${where}`).toBeLessThanOrEqual(1);
}

/**
 * Is this element actually legible where it sits — on screen, non-zero, not
 * spilling past its own scroll container, and hit-testable at its centre?
 *
 * `elementFromPoint` is the hit test jsdom has no implementation of at all, and
 * it is the only way to catch a button covered by an overlay: Playwright's own
 * `toBeVisible()` passes on an element that is painted over.
 */
async function assertReadable(locator: Locator, what: string) {
  await expect(locator, `${what} should be visible`).toBeVisible();
  const box = await locator.boundingBox();
  expect(box, `${what} should have a layout box`).not.toBeNull();
  const viewport = page.viewportSize()!;
  expect(box!.width, `${what} collapsed to zero width`).toBeGreaterThan(0);
  expect(box!.height, `${what} collapsed to zero height`).toBeGreaterThan(0);
  expect(box!.x, `${what} starts off the left of the viewport`).toBeGreaterThanOrEqual(-1);
  expect(
    box!.x + box!.width,
    `${what} extends past the right edge of the viewport (${Math.round(box!.x + box!.width)} > ${viewport.width})`,
  ).toBeLessThanOrEqual(viewport.width + 1);

  // Clipped by an ancestor with hidden overflow? Compare against every
  // ancestor's client rect — this is exactly what "text is clipped" means and
  // what a DOM-only assertion can never see.
  const clip = await locator.evaluate((el) => {
    const r = el.getBoundingClientRect();
    let node = el.parentElement;
    while (node) {
      const style = getComputedStyle(node);
      const clips =
        style.overflowX !== 'visible' ||
        style.overflowY !== 'visible';
      if (clips && style.overflow !== 'auto' && style.overflowX !== 'auto' && style.overflowY !== 'auto' && style.overflow !== 'scroll') {
        const pr = node.getBoundingClientRect();
        if (r.right > pr.right + 1 || r.left < pr.left - 1) {
          return { by: node.tagName + '.' + node.className, right: r.right, parentRight: pr.right };
        }
      }
      node = node.parentElement;
    }
    return null;
  });
  expect(clip, `${what} is clipped horizontally by an ancestor: ${JSON.stringify(clip)}`).toBeNull();
}

/** Click through A's login form. The access token lives in memory, so there is
 *  no shortcut — the refresh cookie only exists after a real login. */
async function login() {
  await page.goto('/login');
  await page.fill('#email', seed.aEmail);
  await page.fill('#password', PASSWORD);
  await page.getByRole('button', { name: /sign in|log in/i }).click();
  await expect(page).not.toHaveURL(/\/login/, { timeout: 15_000 });
}

/**
 * Navigate, and log back in if the app bounced us to /login.
 *
 * NOT DEFENSIVE PADDING — it works around a real, reproducible defect this run
 * surfaced, which is recorded in the spec doc: `ProtectedRoute.tsx` calls
 * `/api/auth/refresh` with a raw `fetch`, bypassing the in-flight dedupe in
 * `api/client.ts` (`attemptRefresh`). On a cold load both fire, the refresh
 * token is single-use and rotated inside a transaction, and the loser gets a
 * 401 — which the client reads as "signed out". It is intermittent, it is
 * outside Plan F's diff (nothing under `api/`, and neither of those two files,
 * is touched by this branch), and it is invisible to jsdom, which never
 * performs a cold page load at all.
 *
 * Scenario 5 hits it because navigating away mid-run is a cold load by
 * definition — which is exactly the user action the scenario is about.
 */
async function gotoAuthed(path: string) {
  await page.goto(path);
  // The bounce is asynchronous — ProtectedRoute refreshes first and only then
  // redirects — so sampling the URL the instant navigation ends would miss it.
  await page.waitForTimeout(1200);
  if (page.url().includes('/login')) {
    console.log(`[auth] bounced to /login on ${path} — cold-load refresh race; signing back in`);
    await login();
    await page.goto(path);
  }
}

async function remoteRow() {
  const remotes = await api(A_API, await aToken(), 'GET', '/sync/remotes');
  return remotes[0];
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ browser }) => {
  // A real context, not `browser.newPage()`: scenario 1 and scenario 3 both need
  // a SECOND page (B's token page, and B's own UI) alongside A's.
  browserRef = browser;
  context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  page = await context.newPage();
  page.on('pageerror', (e) => console.log('[browser pageerror]', e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') console.log('[browser console.error]', m.text());
  });
  await login();
});

test.afterAll(async () => {
  await context?.close();
});

// ─── 1. Add a remote following only what the screen says ────────────────────

test('1. adding a remote is completable from the on-screen guidance alone', async () => {
  await gotoAuthed('/settings/sync');

  // The nav has to advertise the surface before anyone can follow it.
  await assertReadable(
    page.getByRole('link', { name: 'Sync', exact: true }),
    'settings nav Sync link',
  );

  const form = page.getByTestId('add-remote-form');
  await expect(form).toBeVisible();

  // F-05: the one sentence that has to land, because every newcomer pastes a
  // token minted on the wrong instance.
  const guidance = page.getByTestId('sync-pat-guidance');
  await assertReadable(guidance, 'PAT guidance');
  await expect(guidance).toContainText(/token belongs to the/i);
  await expect(guidance).toContainText(/Settings → API tokens/);

  // The deep link must not exist before there is an address to point it at…
  const deepLink = page.getByRole('link', { name: /token page/i });
  await expect(deepLink).toHaveCount(0);

  // …and must appear, pointing at B, as soon as one is typed.
  const baseUrlInput = form.locator('input[inputmode="url"]');
  await baseUrlInput.fill(PEER_URL);
  await assertReadable(deepLink, 'token mint deep link');
  await expect(deepLink).toHaveAttribute('href', `${PEER_URL}/settings/tokens`);

  await shot('add-remote-form-with-deeplink');
  await assertNoPageOverflow('add remote form');

  // That deep link is the instruction's payoff — it has to actually land on a
  // token page on B, not 404.
  // A SEPARATE context, deliberately. Cookies are keyed on host and ignore the
  // port, so :5173 (A) and :3001 (B) share one jar — signing into B in the same
  // context would overwrite A's refresh cookie and sign the tester out of the
  // instance under test. That is an artefact of the rig, not of the product,
  // but it will silently break this suite if it is ignored.
  const bContext = await browserRef.newContext({ viewport: { width: 1280, height: 800 } });
  const tokensPage = await bContext.newPage();
  // Signed in on B first: the deep link is followed by a user who has an
  // account there (that is the whole point — it is where they mint the token),
  // and an unauthenticated SPA would bounce to /login and prove nothing.
  await tokensPage.goto(`${PEER_URL}/login`);
  await tokensPage.fill('#email', seed.bEmail);
  await tokensPage.fill('#password', PASSWORD);
  await tokensPage.getByRole('button', { name: /sign in|log in/i }).click();
  await expect(tokensPage).not.toHaveURL(/\/login/, { timeout: 20_000 });
  const href = (await deepLink.getAttribute('href'))!;
  await tokensPage.goto(href);
  await expect(tokensPage).toHaveURL(/\/settings\/tokens$/);
  await expect(
    tokensPage.getByRole('heading', { name: /Personal access tokens/i }),
    'the deep link must land on a page that actually mints tokens',
  ).toBeVisible({ timeout: 20_000 });
  await bContext.close();

  // Complete the form the way the screen tells you to.
  await form.locator('input[placeholder="Laptop"]').fill('Peer B');
  await form.locator('input[type="password"]').fill(seed.pat);
  await form.getByRole('button', { name: 'Add remote' }).click();

  const table = page.getByTestId('sync-remotes-table');
  await expect(table).toBeVisible();
  await expect(table).toContainText('Peer B');
  await expect(table).toContainText(PEER_URL);
  // The PAT is masked and never echoed back.
  await expect(table).not.toContainText(seed.pat);
  await expect(table.locator('td[data-testid^="remote-pat-"]')).toContainText('••••');

  await shot('remote-saved');
  await assertNoPageOverflow('remotes table');
});

// ─── 2. Test connection, then break it ──────────────────────────────────────

test('2. test connection reports B, and a dead address fails with something actionable', async () => {
  await gotoAuthed('/settings/sync');
  const remote = await remoteRow();

  await page.getByRole('button', { name: `Test connection to Peer B` }).click();
  const status = page.getByTestId(`remote-test-status-${remote.id}`);
  await expect(status).toContainText('Connected', { timeout: 30_000 });
  const connected = (await status.textContent())!;
  // A real handshake: a version and a migration head, not placeholders.
  expect(connected, 'handshake line').toMatch(/Weltbon\s+\S+/);
  expect(connected, 'handshake line').toMatch(/migration\s+\S+/);
  expect(connected, 'handshake must not print undefined').not.toContain('undefined');
  await assertReadable(status, 'handshake success line');
  await shot('test-connection-ok');

  // Break it: edit the base URL to a dead port and test again.
  await page.getByRole('button', { name: 'Edit Peer B' }).click();
  const editForm = page.getByTestId(`edit-remote-form-${remote.id}`);
  await editForm.locator('input[inputmode="url"]').fill(DEAD_URL);
  await editForm.getByRole('button', { name: 'Save changes' }).click();
  await expect(editForm).toHaveCount(0);
  await expect(page.getByTestId('sync-remotes-table')).toContainText(DEAD_URL);

  // The stale green line must be gone — a result belongs to the address it was
  // taken against (SyncSettings' TestState.baseUrl rule).
  await expect(page.getByTestId(`remote-test-status-${remote.id}`)).toHaveCount(0);

  await page.getByRole('button', { name: `Test connection to Peer B` }).click();
  // The pending line and the failure notice share a testid; only the notice is
  // an alert. Discriminating on the role is what stops this reading the
  // "Testing …" placeholder as the answer.
  // (The pending "Testing …" line is not asserted here: a refused connection on
  // loopback resolves in single-digit milliseconds, so whether it is ever
  // painted is a race, not a property.)
  const failure = page.locator(`[data-testid="remote-test-status-${remote.id}"][role="alert"]`);
  await expect(failure).toBeVisible({ timeout: 60_000 });
  const text = (await failure.textContent())!;
  await assertReadable(failure, 'handshake failure notice');
  await shot('test-connection-dead');
  await assertNoPageOverflow('handshake failure');

  // Actionable: prose, naming the peer or the remedy — not a bare code or a
  // stack trace.
  expect(text, 'failure copy').not.toMatch(/^\s*[a-z-]+\s*$/);
  expect(text, 'failure copy must not be a stack trace').not.toContain('    at ');
  expect(text.length, 'failure copy should be a sentence').toBeGreaterThan(25);
  expect(text, 'failure copy should mention the peer or the address').toMatch(
    /instance|address|reach|unreachable|server|offline|refused/i,
  );

  // The raw disclosure. `SyncErrorNotice` decides whether to render it at all,
  // and when it does the content is unwrapped machine text — the case most
  // likely to blow the layout out sideways, and the case jsdom cannot judge
  // because it never lays anything out.
  const details = failure.locator('details');
  if (await details.count()) {
    const pre = details.locator('pre');
    await expect(pre, 'raw details should start collapsed').toBeHidden();
    await details.locator('summary').click();
    await assertReadable(pre, 'raw error details');
    expect((await pre.textContent())!.trim().length, 'raw details opened empty').toBeGreaterThan(0);
    await assertNoPageOverflow('raw error details open');
    await details.locator('summary').click();
  }

  // Put it back so the rest of the run has a working peer.
  await page.getByRole('button', { name: 'Edit Peer B' }).click();
  const editAgain = page.getByTestId(`edit-remote-form-${remote.id}`);
  await editAgain.locator('input[inputmode="url"]').fill(PEER_URL);
  await editAgain.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByTestId('sync-remotes-table')).toContainText(PEER_URL);
});

// ─── 3. First sync of a universe that contains an image ─────────────────────

test('3. first sync copies a universe with an image, end to end', async () => {
  test.setTimeout(240_000);
  await gotoAuthed(`/universes/${seed.universeId}/settings?tab=sync`);

  // Deep-linking to ?tab=sync must land on the Sync tab, not fall back to
  // General (UniverseSettings' safeTab).
  await expect(page.getByRole('heading', { name: 'Sync', exact: true })).toBeVisible();

  // Link the universe through the UI.
  await page.selectOption('#sync-remote-select', { label: 'Peer B' });
  await page.getByRole('button', { name: 'Link universe' }).click();
  const list = page.getByTestId('sync-links-list');
  await expect(list).toBeVisible();
  await expect(list).toContainText('Peer B');
  await expect(list).toContainText('Never synced');
  await shot('link-created');
  await assertNoPageOverflow('sync tab, linked');

  const links = await api(A_API, await aToken(), 'GET', `/sync/links?universeId=${seed.universeId}`);
  const linkId = links[0].id;

  // F-06: the elapsed counter is the ONLY progress signal a run has, and a
  // frozen one ("a correct slow run must not look like a hang") is worse than
  // none. jsdom can assert the span renders; only a real browser can assert it
  // MOVES, on a real clock, over real seconds.
  //
  // The response is held open for a fixed interval so the observation is
  // deterministic. The run itself is entirely real — the request goes to the
  // server, does the whole sync, and comes back; only its DELIVERY to the page
  // is delayed. Without this the rig's own universe finishes in well under a
  // second and the counter never gets a chance to leave `0s`, so a genuinely
  // frozen counter would pass unnoticed — which is the exact defect class this
  // task exists to catch.
  const HOLD_MS = 5_000;
  await page.route('**/api/sync/links/*/run*', async (route) => {
    const response = await route.fetch({ timeout: 180_000 });
    await new Promise((r) => setTimeout(r, HOLD_MS));
    await route.fulfill({ response });
  });

  const syncNow = page.getByRole('button', { name: /^Sync now with/ });
  await assertReadable(syncNow, 'Sync now button');
  await syncNow.click();

  const elapsed = page.getByTestId(`sync-link-elapsed-${linkId}`);
  const summary = page.getByTestId(`sync-link-result-${linkId}`);
  const runError = page.getByTestId(`sync-link-run-error-${linkId}`);

  // The running region has to appear at all — a blocking run with no feedback
  // is indistinguishable from a dead button.
  const running = page.locator('[role="status"]', { has: elapsed });
  await expect(running).toBeVisible({ timeout: 30_000 });
  await assertReadable(running, 'running status region');
  // First sync of this link: the warning that it copies everything, and may
  // take minutes, must be on screen while the user is waiting for exactly that.
  await expect(running).toContainText(/first sync/i);
  await expect(running).toContainText(/Keep this tab open/i);
  // While a run blocks, its own controls are out of action…
  await expect(syncNow).toBeDisabled();
  await expect(page.getByRole('button', { name: /^Remove link to/ })).toBeDisabled();
  // …but the rest of the page stays usable. A blocking run must not freeze the
  // app; the tab bar is the cheapest proof that it does not.
  await expect(page.getByRole('tab', { name: 'General' })).toBeEnabled();

  const seen: string[] = [];
  const watchUntil = Date.now() + HOLD_MS - 500;
  while (Date.now() < watchUntil && (await elapsed.count())) {
    const t = (await elapsed.textContent())!.trim();
    if (!seen.includes(t)) {
      seen.push(t);
      if (seen.length === 2) await shot('sync-running');
    }
    await page.waitForTimeout(200);
  }
  expect(
    seen.length,
    `elapsed counter never advanced past ${seen[0] ?? '(nothing)'} over ${HOLD_MS}ms — it is frozen`,
  ).toBeGreaterThan(1);
  expect(seen[0], 'the counter should start at 0s').toBe('0s');
  // Real seconds, in order — not a value that jumps or resets.
  const numbers = seen.map((s) => parseInt(s, 10));
  expect(numbers, 'the counter must count up').toEqual([...numbers].sort((a, b) => a - b));

  await expect(runError, 'first sync should not fail').toHaveCount(0);
  await expect(summary).toBeVisible({ timeout: 180_000 });
  // Only now — unrouting while the handler is mid-hold makes Playwright
  // continue the route itself, firing a SECOND real sync whose summary
  // (correctly) reports nothing changed and hides the first run's result.
  await page.unroute('**/api/sync/links/*/run*');

  await assertReadable(summary, 'run summary');
  const summaryText = (await summary.textContent())!;
  // A first sync of a universe holding an entry AND an image has to say so:
  // that it bootstrapped, how many changes went out, and how many FILES moved.
  expect(summaryText, 'summary must say this was a first sync').toMatch(/First sync complete/i);
  expect(summaryText, 'summary must name what moved').toMatch(/Sent \d+ change/);
  expect(summaryText, 'summary must account for the image bytes').toMatch(
    /Transferred \d+ files? \(\d+ out, \d+ in\)/,
  );
  await shot('sync-done');
  await assertNoPageOverflow('sync summary');

  // The run is over: the controls come back.
  await expect(syncNow).toBeEnabled();
  await expect(list).toContainText(/Last synced/);

  // ── Did it actually arrive on B? Checked over B's own API… ──
  const bAuth = await bToken();
  const bUniverses = await api(B_API, bAuth, 'GET', '/universes');
  const mirrored = bUniverses.find((u: any) => u.id === seed.universeId);
  expect(mirrored, `universe ${seed.universeId} did not arrive on B`).toBeTruthy();

  const bEntries = await api(B_API, bAuth, 'GET', `/universes/${seed.universeId}/entries`);
  expect(
    bEntries.some((e: any) => e.id === seed.entryId),
    'entry did not arrive on B',
  ).toBe(true);

  const bAssets = await api(B_API, bAuth, 'GET', `/universes/${seed.universeId}/assets`);
  const bAsset = bAssets.find((a: any) => a.id === seed.assetId);
  expect(bAsset, 'asset row did not arrive on B').toBeTruthy();

  // …and, crucially, the BYTES, not just the row. An asset row without its file
  // is the failure mode Plan F0 was written for.
  const raw = await fetch(`${B_API}/universes/${seed.universeId}/assets/${seed.assetId}/raw`, {
    headers: { Authorization: `Bearer ${bAuth}` },
  });
  expect(raw.status, 'asset bytes on B').toBe(200);
  const bytes = Buffer.from(await raw.arrayBuffer());
  expect(bytes.length, 'asset bytes on B are empty').toBeGreaterThan(0);
  expect(bytes.subarray(0, 8).toString('hex'), 'asset on B is not a PNG').toBe(
    TINY_PNG.subarray(0, 8).toString('hex'),
  );

  // ── …and in B's own browser UI, which is the actual claim being made. ──
  // Separate context — see the cookie note in scenario 1.
  const bContext = await browserRef.newContext({ viewport: { width: 1280, height: 800 } });
  const bPage = await bContext.newPage();
  await bPage.goto(`${B_UI}/login`);
  await bPage.fill('#email', seed.bEmail);
  await bPage.fill('#password', PASSWORD);
  await bPage.getByRole('button', { name: /sign in|log in/i }).click();
  await expect(bPage).not.toHaveURL(/\/login/, { timeout: 20_000 });
  await bPage.goto(`${B_UI}/universes/${seed.universeId}/assets`);
  await expect(bPage.locator('body')).toContainText(seed.assetFilename, { timeout: 20_000 });
  await bPage.screenshot({ path: resolve(SHOTS, '00-b-received-media.png'), fullPage: true });
  await bPage.goto(`${B_UI}/universes/${seed.universeId}/entries/${seed.entryId}`);
  await expect(bPage.locator('body')).toContainText(seed.entryTitle, { timeout: 20_000 });
  await bPage.screenshot({ path: resolve(SHOTS, '00-b-received-entry.png'), fullPage: true });
  await bContext.close();
});

// ─── 4. Force a conflict ────────────────────────────────────────────────────

test('4. a conflicting edit is reported, badged, restorable and dismissible', async () => {
  test.setTimeout(240_000);

  // Edit the same entry on BOTH instances. B first, A second, so A's clock is
  // later and local wins — the loser payload is then B's version, which is what
  // the list should offer to restore.
  await api(B_API, await bToken(), 'PATCH', `/universes/${seed.universeId}/entries/${seed.entryId}`, {
    body: 'REMOTE VERSION — written on instance B.',
  });
  await new Promise((r) => setTimeout(r, 1500));
  await api(A_API, await aToken(), 'PATCH', `/universes/${seed.universeId}/entries/${seed.entryId}`, {
    body: 'LOCAL VERSION — written on instance A.',
  });

  await gotoAuthed(`/universes/${seed.universeId}/settings?tab=sync`);
  const links = await api(A_API, await aToken(), 'GET', `/sync/links?universeId=${seed.universeId}`);
  const linkId = links[0].id;

  await page.getByRole('button', { name: /^Sync now with/ }).click();
  const summary = page.getByTestId(`sync-link-result-${linkId}`);
  const runError = page.getByTestId(`sync-link-run-error-${linkId}`);
  await expect(summary.or(runError)).toBeVisible({ timeout: 180_000 });
  await expect(runError, 'conflicting sync should still succeed').toHaveCount(0);

  // The summary names the conflict — a run that silently sets a version aside
  // is the one thing this feature promises not to do.
  await expect(summary).toContainText(/conflict/i);
  await shot('conflict-run-summary');

  const conflictList = page.getByTestId('sync-conflicts-list');
  await expect(conflictList).toBeVisible({ timeout: 20_000 });
  const rows = conflictList.locator('li');
  await expect(rows).not.toHaveCount(0);
  const row = rows.first();
  await assertReadable(row, 'conflict row');
  await expect(row).toContainText('entries');
  await expect(row, 'the row must say which side won').toContainText(/instance won|winner/i);

  // The disclosure has to actually open and show readable JSON — a <details>
  // that renders but never expands is exactly the class of defect jsdom cannot
  // see, since it has no rendering at all.
  const payloadId = await row
    .locator('pre[data-testid^="sync-conflict-payload-"]')
    .getAttribute('data-testid');
  const payload = page.getByTestId(payloadId!);
  await expect(payload, 'payload should start collapsed').toBeHidden();
  await row.locator('summary').click();
  await assertReadable(payload, 'conflict payload JSON');
  const json = (await payload.textContent())!;
  expect(() => JSON.parse(json), 'payload is not valid JSON').not.toThrow();
  expect(json, 'payload should be the version that lost').toContain('REMOTE VERSION');
  await shot('conflict-payload-open');
  await assertNoPageOverflow('conflict payload open');

  // ── The sidebar badge. `ml-auto` inside a nav link is precisely the thing
  //    jsdom cannot judge: it can see the span exists, not whether it is on
  //    screen next to the label rather than overflowing or wrapping. ──
  await gotoAuthed(`/universes/${seed.universeId}/entries/${seed.entryId}`);
  const badge = page.getByTestId('sidebar-sync-badge');
  await assertReadable(badge, 'sidebar sync badge');
  const badgeText = (await badge.textContent())!;
  expect(badgeText.trim(), 'badge count').toMatch(/^\d/);
  const conflicts = await api(
    A_API,
    await aToken(),
    'GET',
    `/sync/conflicts?universeId=${seed.universeId}`,
  );
  expect(parseInt(badgeText, 10), 'badge count must match the server').toBe(conflicts.length);

  // The badge must sit inside its nav link, not spill out of it.
  const navLink = page.locator('a', { has: page.getByTestId('sidebar-sync-badge') }).first();
  const [bb, nb] = await Promise.all([badge.boundingBox(), navLink.boundingBox()]);
  expect(bb!.x + bb!.width, 'badge overflows its nav link').toBeLessThanOrEqual(nb!.x + nb!.width + 1);
  expect(bb!.y, 'badge wrapped below its nav link').toBeGreaterThanOrEqual(nb!.y - 1);
  expect(bb!.y + bb!.height, 'badge wrapped below its nav link').toBeLessThanOrEqual(
    nb!.y + nb!.height + 1,
  );
  await shot('sidebar-badge');

  // Clicking it must land on the Sync tab.
  await navLink.click();
  await expect(page).toHaveURL(/tab=sync/);
  await expect(page.getByTestId('sync-conflicts-list')).toBeVisible();

  // ── Restore writes the loser back. ──
  const before = (await api(
    A_API,
    await aToken(),
    'GET',
    `/universes/${seed.universeId}/entries/${seed.entryId}`,
  )) as any;
  expect(before.body).toContain('LOCAL VERSION');

  await page.getByRole('button', { name: /^Restore the replaced version of/ }).first().click();
  await expect
    .poll(
      async () => {
        const e = await api(
          A_API,
          await aToken(),
          'GET',
          `/universes/${seed.universeId}/entries/${seed.entryId}`,
        );
        return e.body as string;
      },
      { timeout: 30_000, message: 'Restore did not write the losing version back' },
    )
    .toContain('REMOTE VERSION');
  await shot('after-restore');

  // ── Dismiss clears the badge. ──
  const remaining = await api(
    A_API,
    await aToken(),
    'GET',
    `/sync/conflicts?universeId=${seed.universeId}`,
  );
  for (let i = 0; i < remaining.length + 2; i += 1) {
    const dismiss = page.getByRole('button', { name: /^Dismiss the conflict for/ }).first();
    if (!(await dismiss.count())) break;
    await dismiss.click();
    await page.waitForTimeout(400);
  }
  await expect(page.getByTestId('sync-conflicts-empty')).toBeVisible({ timeout: 20_000 });

  await gotoAuthed(`/universes/${seed.universeId}/entries/${seed.entryId}`);
  await expect(page.getByTestId('sidebar-sync-badge')).toHaveCount(0, { timeout: 20_000 });
  await shot('badge-cleared');
});

// ─── 5. Recover a stuck lease ───────────────────────────────────────────────

test('5. a lease left behind by a closed tab is recoverable with Run anyway', async () => {
  test.setTimeout(240_000);
  const links = await api(A_API, await aToken(), 'GET', `/sync/links?universeId=${seed.universeId}`);
  const linkId = links[0].id;

  // Give the run enough work that navigating away lands mid-flight. Without
  // this the whole run finishes inside a few hundred ms and there is no window.
  // Each of these is a separate blob push to the peer, so the count is the
  // knob: 60 tiny PNGs buy a few seconds of real transfer.
  const token = await aToken();
  for (let i = 0; i < 60; i += 1) {
    const form = new FormData();
    form.append('file', new Blob([TINY_PNG], { type: 'image/png' }), `filler-${Date.now()}-${i}.png`);
    await api(A_API, token, 'POST', `/universes/${seed.universeId}/assets`, form);
  }

  await gotoAuthed(`/universes/${seed.universeId}/settings?tab=sync`);
  const runRequest = page.waitForRequest((r) => /\/api\/sync\/links\/[^/]+\/run/.test(r.url()));
  await page.getByRole('button', { name: /^Sync now with/ }).click();
  // Leave as soon as the request is genuinely on the wire — waiting for the
  // elapsed counter to paint first would burn most of the window.
  await runRequest;

  // Close the tab on it, the way a user does.
  await page.goto('about:blank');

  // HALF ONE, REAL: leaving the page does not cancel the run, and the claim
  // outlives the tab that started it. That is the premise of the whole
  // scenario, and it is checked against db-a rather than assumed.
  const heldAfterLeaving = psqlA(
    `select status from sync_links where id = '${linkId}'`,
  ).trim();
  console.log(`[scenario 5] link status immediately after navigating away: ${heldAfterLeaving}`);
  expect(
    heldAfterLeaving,
    'navigating away should leave the run — and its claim — in flight on the server',
  ).toBe('syncing');

  // HALF TWO: the recovery. The abandoned run is left to finish first, so it
  // cannot release the lease underneath the assertions below (that is exactly
  // what made this scenario flaky: the tester gets back to the page seconds
  // later, by which time a healthy run has already completed). Then the exact
  // state a genuinely dead run leaves — status 'syncing' with a fresh
  // `updated_at`, so the 30-minute lease has not aged out — is reproduced
  // directly, which is the only way to hold it still long enough to drive the
  // UI through it.
  await expect
    .poll(() => psqlA(`select status from sync_links where id = '${linkId}'`).trim(), {
      timeout: 120_000,
      message: 'the abandoned run never finished server-side',
    })
    .not.toBe('syncing');
  psqlA(`update sync_links set status = 'syncing', updated_at = now() where id = '${linkId}'`);
  expect(psqlA(`select status from sync_links where id = '${linkId}'`).trim()).toBe('syncing');

  await gotoAuthed(`/universes/${seed.universeId}/settings?tab=sync`);
  await page.getByRole('button', { name: /^Sync now with/ }).click();

  const runError = page.getByTestId(`sync-link-run-error-${linkId}`);
  await expect(runError).toBeVisible({ timeout: 60_000 });
  await assertReadable(runError, 'busy error notice');
  const busyText = (await runError.textContent())!;
  expect(busyText, 'busy copy should explain, not just say "busy"').toMatch(
    /already|in progress|running|another/i,
  );
  await shot('busy-run-anyway');
  await assertNoPageOverflow('busy error');

  const runAnyway = page.getByRole('button', { name: /^Run anyway with/ });
  await assertReadable(runAnyway, 'Run anyway button');
  await runAnyway.click();

  const summary = page.getByTestId(`sync-link-result-${linkId}`);
  await expect(summary).toBeVisible({ timeout: 180_000 });
  await assertReadable(summary, 'forced run summary');
  expect(psqlA(`select status from sync_links where id = '${linkId}'`).trim()).not.toBe('syncing');
  await shot('forced-run-done');
});
