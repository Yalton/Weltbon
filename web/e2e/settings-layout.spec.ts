import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { SEED_FILE, psql, type Seed } from './seed';

const seed: Seed = JSON.parse(readFileSync(SEED_FILE, 'utf8'));

/**
 * An admin sees every settings tab, the widest the nav gets. At phone width
 * the tabs must fit inside the screen instead of making the page scroll sideways.
 */
test.describe('settings layout at phone width', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test.beforeAll(() => {
    psql(seed.dbHost, `update users set is_admin = true where id = '${seed.userId}'`);
  });

  test('the admin settings nav does not overflow the page', async ({ page }) => {
    await page.goto('/login');
    await page.getByLabel(/email/i).fill(seed.email);
    await page.getByLabel(/password/i).fill('longenoughpw12');
    await page.getByRole('button', { name: /log in/i }).click();
    await page.waitForURL('**/universes');

    await page.goto('/settings/invites');
    await expect(page.getByRole('link', { name: 'Invite codes' })).toBeVisible();

    const { scrollWidth, innerWidth } = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      innerWidth: window.innerWidth,
    }));
    expect(scrollWidth, 'the page scrolls horizontally').toBeLessThanOrEqual(innerWidth);
  });
});
