import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { API, SEED_FILE, api, psql, type Seed } from './seed';

const seed: Seed = JSON.parse(readFileSync(SEED_FILE, 'utf8'));

/**
 * The server sends a Content-Security-Policy (api/src/security-headers.ts).
 * Walk every screen and fail on anything the policy blocks, so a new inline
 * script, CDN asset or eval-based library shows up here rather than as a
 * blank screen in production.
 */
async function recordViolations(page: Page): Promise<string[]> {
  const violations: string[] = [];
  await page.exposeFunction('__reportCsp', (v: string) => violations.push(v));
  await page.addInitScript(() => {
    document.addEventListener('securitypolicyviolation', (e) => {
      (window as unknown as { __reportCsp: (v: string) => void }).__reportCsp(
        `${e.violatedDirective} blocked ${e.blockedURI || 'inline'} on ${location.pathname}`,
      );
    });
  });
  page.on('console', (msg) => {
    if (/Content Security Policy/i.test(msg.text())) violations.push(msg.text());
  });
  return violations;
}

async function visit(page: Page, path: string) {
  await page.goto(path);
  // Some screens poll, so the network may never go idle; give each a few
  // seconds to load its lazy chunks and data, then move on.
  await page.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => {});
  await expect(page.getByText('Something went wrong'), path).toHaveCount(0, { timeout: 15_000 });
}

test.describe('Content-Security-Policy', () => {
  let mapId: string;
  let diagramId: string;

  test.beforeAll(async () => {
    psql(seed.dbHost, `update users set is_admin = true where id = '${seed.userId}'`);
    // A map needs an uploaded image; the favicon is a real PNG.
    const form = new FormData();
    form.append('file', new Blob([readFileSync(resolve('public/favicon-48.png'))], { type: 'image/png' }), 'map.png');
    const upload = await fetch(`${API}/universes/${seed.uid}/assets`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${seed.ownerToken}` },
      body: form,
    });
    expect(upload.ok, await upload.clone().text()).toBe(true);
    const asset = await upload.json();
    mapId = (await api(seed.ownerToken, 'POST', `/universes/${seed.uid}/maps`, { name: 'CSP map', imageAssetId: asset.id })).id;
    diagramId = (await api(seed.ownerToken, 'POST', `/universes/${seed.uid}/diagrams`, { name: 'CSP diagram' })).id;
  });

  test('the public pages and the share view load nothing the policy blocks', async ({ page }) => {
    const violations = await recordViolations(page);
    const share = `/share/${seed.shareToken}`;
    for (const path of ['/', '/login', '/register', '/request-invite', share, `${share}/entries/${seed.mainId}`,
      `${share}/graph`, `${share}/timeline`, `${share}/maps`]) {
      await visit(page, path);
    }
    expect(violations).toEqual([]);
  });

  test('every signed-in screen loads nothing the policy blocks', async ({ page }) => {
    test.setTimeout(240_000); // ~30 screens, each allowed a few seconds to settle
    const violations = await recordViolations(page);
    await page.goto('/login');
    await page.getByLabel(/email/i).fill(seed.email);
    await page.getByLabel(/password/i).fill('longenoughpw12');
    await page.getByRole('button', { name: /log in/i }).click();
    await page.waitForURL('**/universes');

    const u = `/universes/${seed.uid}`;
    for (const path of [
      '/universes', `${u}/settings`, `${u}/entries`, `${u}/entries/new`, `${u}/entries/${seed.mainId}`,
      `${u}/entries/${seed.mainId}/edit`, `${u}/graph`, `${u}/timeline`, `${u}/stats`, `${u}/calendar`,
      `${u}/events`, `${u}/diagrams`, `${u}/diagrams/${diagramId}`, `${u}/maps`, `${u}/maps/${mapId}`,
      `${u}/assets`, `${u}/dictionary`, `${u}/languages/${seed.langId}/dictionary`, `${u}/issues`,
      `${u}/import`, '/settings', '/settings/tokens', '/settings/invites', '/settings/users',
      '/settings/templates', '/settings/shares', '/settings/llm', '/settings/sync',
    ]) {
      await visit(page, path);
    }
    expect(violations).toEqual([]);
  });
});
