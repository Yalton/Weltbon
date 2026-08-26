import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { SEED_FILE, type Seed } from './seed';

const seed: Seed = JSON.parse(readFileSync(SEED_FILE, 'utf8'));
const PASSWORD = 'longenoughpw12';

test('keeps the narrow Markdown toolbar keyboard reachable in a real browser', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 800 });

  await page.goto('/login');
  await page.getByLabel('Email').fill(seed.email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Log in' }).click();
  await expect(page).not.toHaveURL(/\/login$/, { timeout: 15_000 });

  await page.goto(`/universes/${seed.uid}/entries/new`);
  await expect(page.getByRole('heading', { name: 'New entry' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Markdown authoring editor' })).toBeVisible();

  const sourceToggle = page.getByRole('button', { name: 'Source' });
  await sourceToggle.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('textbox', { name: 'Entry body' })).toBeVisible();

  const more = page.getByRole('button', { name: 'More formatting commands' });
  const commands = page.getByRole('button', { name: 'Open formatting command palette' });
  await expect(more).toBeVisible();
  await expect(commands).toBeHidden();

  // Narrow/touch path: keyboard activation must work without hover or pointer input.
  await more.focus();
  await expect(more).toBeFocused();
  await page.keyboard.press('Enter');

  const palette = page.getByRole('dialog', { name: 'Formatting commands' });
  await expect(palette).toBeVisible();
  const paragraph = page.getByRole('option', { name: 'Paragraph' });
  const heading = page.getByRole('option', { name: 'Heading 1' });
  await expect(paragraph).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(heading).toBeFocused();
  await page.keyboard.press('Enter');

  await expect(palette).toBeHidden();
  await expect(page.getByRole('textbox', { name: 'Entry body' })).toHaveValue('# Heading');
});
