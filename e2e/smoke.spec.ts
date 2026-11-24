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
  // index.html ships a static branded boot frame inside #root, so 'not empty'
  // alone would pass even if React never mounted. React replaces it on its
  // first commit.
  await expect(page.locator('#root [data-pq-boot]')).toHaveCount(0);

  expect(
    pageErrors,
    `Uncaught browser errors detected:\n${pageErrors.join('\n')}`,
  ).toEqual([]);
});
