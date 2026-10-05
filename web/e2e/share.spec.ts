import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { SEED_FILE, type Seed } from './seed';

const seed: Seed = JSON.parse(readFileSync(SEED_FILE, 'utf8'));
const share = (sub = '') => `/share/${seed.shareToken}${sub}`;

test.describe('public share surface', () => {
  test('renders the universe without the ErrorBoundary crash (bare-array contract)', async ({
    page,
  }) => {
    await page.goto(share());

    // The bare-array bug crashed the whole subtree into ShareFallback.
    await expect(page.getByText('Something went wrong')).toHaveCount(0);
    await expect(page.getByText(/Shared read-only view of/)).toBeVisible();
    // Public entries actually list (proves /api/share/entries returns an array).
    await expect(page.getByText('The Battle of Zephyrs')).toBeVisible();
  });

  test('entry detail shows the in-world calendar date (CALENDAR-02 in share)', async ({
    page,
  }) => {
    await page.goto(share(`/entries/${seed.mainId}`));

    await expect(page.getByText('Something went wrong')).toHaveCount(0);
    // Calendar threaded via ShareModeContext; NOT the raw numeric position.
    await expect(page.getByText(/Frostmoon, 413 TE/)).toBeVisible();
    await expect(page.getByText(String(100129))).toHaveCount(0);
  });

  test('[[entry]] wikilink navigates inside the share subtree, not /login (INT-BLOCKER-2)', async ({
    page,
  }) => {
    await page.goto(share(`/entries/${seed.mainId}`));

    const link = page.getByRole('link', { name: 'Frostspire Keep' }).first();
    await expect(link).toHaveAttribute('href', share(`/entries/${seed.targetId}`));

    await link.click();
    await expect(page).toHaveURL(new RegExp(`/share/[^/]+/entries/${seed.targetId}$`));
    await expect(page).not.toHaveURL(/\/login/);
    await expect(page.getByText('A mountain fortress')).toBeVisible();
  });

  test('[[word]] resolves to a hover popover with gloss + IPA (CONLANG-04 in share)', async ({
    page,
  }) => {
    await page.goto(share(`/entries/${seed.mainId}`));

    await page.getByText('zephyr', { exact: true }).hover();
    await expect(page.getByText('a gentle western wind')).toBeVisible();
    await expect(page.getByText(/zɛf/)).toBeVisible();
  });

  test('share timeline renders (timelineWindow delivered) and the pin opens its entry', async ({
    page,
  }) => {
    await page.goto(share('/timeline'));

    // Without timelineWindow in share meta this said "No timeline is available".
    await expect(page.getByText(/No timeline is available/)).toHaveCount(0);

    // The pin is a React-rendered medallion <g data-pin-id>; clicking it must
    // open the entry (the d3 click handler was broken + suppressed the React click).
    const pin = page.locator('[data-testid="pin-layer"] [data-pin-id]').first();
    await expect(pin).toBeVisible();
    // Click the disc itself: the pin group's box also spans its label, so its
    // center can land past the disc on the baseline.
    await pin.locator('.medallion-disc').click();

    await expect(page).toHaveURL(new RegExp(`/share/[^/]+/entries/${seed.mainId}$`));
    await expect(page.getByText('A clash at the keep')).toBeVisible();
  });
});
