import { test, expect, type Locator, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { SEED_FILE, type Seed } from './seed';

const seed: Seed = JSON.parse(readFileSync(SEED_FILE, 'utf8'));
const PASSWORD = 'longenoughpw12';

test.use({ viewport: { width: 390, height: 844 } });

async function logIn(page: Page) {
  await page.goto('/login');
  await page.getByLabel('Email').fill(seed.email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Log in' }).click();
  await expect(page).not.toHaveURL(/\/login$/, { timeout: 15_000 });
}

// The universe layout scrolls inside <main>, so sideways overflow can show up
// there as well as on the document.
async function horizontalOverflow(page: Page) {
  return page.evaluate(() => {
    const over = (el: Element | null) => (el ? el.scrollWidth - el.clientWidth : 0);
    return {
      document: over(document.scrollingElement),
      main: over(document.querySelector('main')),
    };
  });
}

const routes: Array<[string, () => string, (page: Page) => Locator]> = [
  ['entries', () => `/universes/${seed.uid}/entries`, (p) => p.getByText('The Battle of Zephyrs')],
  [
    'entry detail',
    () => `/universes/${seed.uid}/entries/${seed.mainId}`,
    (p) => p.getByText('A clash at the keep'),
  ],
  ['graph', () => `/universes/${seed.uid}/graph`, (p) => p.getByTestId('graph-canvas')],
  ['settings', () => `/universes/${seed.uid}/settings`, (p) => p.getByRole('tab', { name: 'General' })],
];

test.describe('universe pages at phone width', () => {
  test.beforeEach(async ({ page }) => {
    await logIn(page);
  });

  for (const [name, path, ready] of routes) {
    test(`${name} has no horizontal overflow`, async ({ page }) => {
      await page.goto(path());
      await expect(ready(page).first()).toBeVisible();
      expect(await horizontalOverflow(page)).toEqual({ document: 0, main: 0 });
    });
  }

  test('navigation drawer opens from the header and closes', async ({ page }) => {
    await page.goto(`/universes/${seed.uid}/entries`);
    await expect(page.getByText('The Battle of Zephyrs').first()).toBeVisible();

    // The fixed sidebar is gone; the header button opens it as a drawer.
    await expect(page.getByRole('navigation', { name: 'Universe navigation' })).toBeHidden();
    const open = page.getByRole('button', { name: 'Open navigation' });
    await open.click();
    const drawer = page.getByRole('dialog', { name: 'Universe navigation' });
    await expect(drawer).toBeVisible();
    await expect(drawer.getByRole('link', { name: 'Graph' })).toBeVisible();

    // Escape closes it and returns focus to the trigger.
    await page.keyboard.press('Escape');
    await expect(drawer).toBeHidden();
    await expect(open).toBeFocused();

    // Following a link closes it too.
    await open.click();
    await drawer.getByRole('link', { name: 'Graph' }).click();
    await expect(page).toHaveURL(new RegExp(`/universes/${seed.uid}/graph$`));
    await expect(drawer).toBeHidden();
  });
});
