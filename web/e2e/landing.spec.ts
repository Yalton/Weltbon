import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { SEED_FILE, psql, type Seed } from './seed';

const seed: Seed = JSON.parse(readFileSync(SEED_FILE, 'utf8'));

/**
 * The public front door end to end: a visitor lands on /, requests an
 * invitation, an admin issues a code from the Invites page, and that code
 * creates the visitor's account.
 */
test.describe('landing page and invitation requests', () => {
  const stamp = Date.now();
  const requester = { name: `Visitor ${stamp}`, email: `visitor-${stamp}@test.local` };

  test.beforeAll(() => {
    psql(seed.dbHost, `update users set is_admin = true where id = '${seed.userId}'`);
  });

  test.afterAll(() => {
    // Best effort, like global-teardown: the consumed invite references the new user.
    try {
      psql(seed.dbHost, `delete from invite_requests where email = '${requester.email}'`, { quiet: true });
      psql(
        seed.dbHost,
        `delete from invite_codes where consumed_by_user_id in (select id from users where email = '${requester.email}')`,
        { quiet: true },
      );
      psql(seed.dbHost, `delete from users where email = '${requester.email}'`, { quiet: true });
    } catch {
      /* ignore */
    }
  });

  test('a signed-out visitor sees what Weltbon is and both ways in', async ({ page }) => {
    await page.goto('/');

    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await expect(page.getByText(/self-hosted workspace for worldbuilding/i)).toBeVisible();
    await expect(page.getByRole('link', { name: /request an invitation/i })).toHaveAttribute('href', '/request-invite');
    await expect(page.getByRole('link', { name: /get the source/i })).toHaveAttribute(
      'href',
      'https://github.com/Citreum-LLC/Weltbon',
    );
  });

  test('a requested invitation is issued by an admin and registers the visitor', async ({ browser }) => {
    // 1. The visitor asks for an invitation.
    const visitor = await browser.newContext();
    const visitorPage = await visitor.newPage();
    await visitorPage.goto('/');
    await visitorPage.getByRole('link', { name: /request an invitation/i }).click();
    await visitorPage.getByLabel(/^name/i).fill(requester.name);
    await visitorPage.getByLabel(/^email/i).fill(requester.email);
    await visitorPage.getByLabel(/what would you like to build/i).fill('A drowned archipelago');
    await visitorPage.getByRole('button', { name: /send request/i }).click();
    await expect(visitorPage.getByRole('heading', { name: /request sent/i })).toBeVisible();

    // 2. An admin issues a code from the Invites page.
    const admin = await browser.newContext();
    const adminPage = await admin.newPage();
    await adminPage.goto('/login');
    await adminPage.getByLabel(/email/i).fill(seed.email);
    await adminPage.getByLabel(/password/i).fill('longenoughpw12');
    await adminPage.getByRole('button', { name: /log in/i }).click();
    await adminPage.waitForURL('**/universes');
    await adminPage.goto('/settings/invites');

    const row = adminPage.getByTestId('invite-requests-list').getByRole('listitem').filter({ hasText: requester.email });
    await expect(row).toBeVisible();
    await row.getByRole('button', { name: /issue code/i }).click();
    const code = (await adminPage.getByLabel('Issued invite code').textContent())?.trim() ?? '';
    expect(code).not.toBe('');
    await admin.close();

    // 3. The visitor registers with it.
    await visitorPage.goto('/register');
    await visitorPage.getByLabel(/display name/i).fill(requester.name);
    await visitorPage.getByLabel(/^email/i).fill(requester.email);
    await visitorPage.getByLabel(/^password/i).fill('longenoughpw12');
    await visitorPage.getByLabel(/invite code/i).fill(code);
    await visitorPage.getByRole('button', { name: /create account/i }).click();
    await visitorPage.waitForURL('**/universes');
    await visitor.close();
  });
});
