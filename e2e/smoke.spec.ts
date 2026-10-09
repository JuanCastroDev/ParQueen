import { test, expect } from '@playwright/test';

test('ParQueen boots without an uncaught page crash', async ({ page }) => {
  const pageErrors: string[] = [];

  page.on('pageerror', (error) => {
    pageErrors.push(error.message);
  });

  await page.goto('/');

  const root = page.locator('#root');

  await expect(root).toBeVisible();
  await expect(root).not.toBeEmpty();

  expect(
    pageErrors,
    `Uncaught browser errors detected:\n${pageErrors.join('\n')}`,
  ).toEqual([]);
});
