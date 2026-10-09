import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

test('ParQueen has no detectable WCAG A/AA violations on initial load', async ({ page }) => {
  await page.goto('/');

  const results = await new AxeBuilder({ page })
    .withTags([
      'wcag2a',
      'wcag2aa',
      'wcag21a',
      'wcag21aa',
    ])
    .analyze();

  await test.info().attach('axe-results.json', {
    body: JSON.stringify(results, null, 2),
    contentType: 'application/json',
  });

  expect(
    results.violations,
    results.violations
      .map(
        (violation) =>
          `[${violation.impact ?? 'unknown'}] ${violation.id}: ${violation.help} (${violation.nodes.length} node(s))`,
      )
      .join('\n'),
  ).toEqual([]);
});
