import React from 'react';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { chromium, type Browser, type Page } from '@playwright/test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CurbSideCrossSection } from './CurbSideCrossSection';
import type { SideConfirmation } from '../../utils/canonicalCurbClient';

const token = (rank: string) => `candidate2_${'b'.repeat(16)}_${rank.repeat(32)}`;
const css = (() => {
  const source = readFileSync(new URL('../../index.css', import.meta.url), 'utf8');
  const start = source.indexOf('.pq-curb-side,');
  const end = source.indexOf('.pq-mycar-remind-grid');
  return source.slice(start, end);
})();

function confirmation(
  axis: 'east-west' | 'north-south',
  first: SideConfirmation['curbs'][number],
  second: SideConfirmation['curbs'][number],
): SideConfirmation {
  return {
    streetName: 'Maran Place',
    orientation: { north: 'up', axis },
    curbs: [first, second],
  };
}

function pageHtml(markup: string) {
  return `<!doctype html><html><head><style>
    body { margin: 0; width: 320px; }
    ${css}
  </style></head><body>${markup}</body></html>`;
}

async function render(page: Page, node: React.ReactElement) {
  await page.setContent(pageHtml(renderToStaticMarkup(node)));
}

async function boxes(page: Page) {
  return page.evaluate(() => {
    const read = (selector: string) => {
      const element = document.querySelector(selector);
      if (!element) return null;
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return {
        x: rect.x, y: rect.y, right: rect.right, bottom: rect.bottom,
        width: rect.width, height: rect.height,
        gridArea: style.gridArea,
      };
    };
    const stage = document.querySelector('.pq-curb-side-stage');
    const stageStyle = stage ? getComputedStyle(stage) : null;
    return {
      display: stageStyle?.display ?? null,
      areas: stageStyle?.gridTemplateAreas ?? null,
      northMark: read('.pq-curb-side-north'),
      road: read('.pq-curb-side-road'),
      north: read('[data-cardinal="North"]'),
      south: read('[data-cardinal="South"]'),
      west: read('[data-cardinal="West"]'),
      east: read('[data-cardinal="East"]'),
      choices: document.querySelectorAll('.pq-curb-side-choice').length,
      viewport: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth,
    };
  });
}

describe('curb cross-section rendered layout', () => {
  let browser: Browser;
  let page: Page;

  beforeAll(async () => {
    browser = await chromium.launch();
    page = await browser.newPage({ viewport: { width: 320, height: 700 } });
  });

  afterAll(async () => {
    await browser?.close();
  });

  it('places north above and south below an east-west road on a narrow screen', async () => {
    await render(page, (
      <CurbSideCrossSection
        confirmation={confirmation('east-west',
          { token: token('1'), cardinal: 'South' },
          { token: token('2'), cardinal: 'North' })}
        onSelect={() => {}}
        onCancel={() => {}}
        loading={false}
      />
    ));
    const laid = await boxes(page);
    expect(laid.display).toBe('grid');
    expect(laid.areas).toContain('north');
    expect(laid.areas).toContain('south');
    expect(laid.northMark!.y).toBeLessThan(laid.road!.y);
    expect(laid.north!.bottom).toBeLessThanOrEqual(laid.road!.y);
    expect(laid.south!.y).toBeGreaterThanOrEqual(laid.road!.bottom);
    expect(laid.north!.width).toBeGreaterThan(laid.road!.width * 0.8);
    expect(laid.north!.height).toBeGreaterThanOrEqual(48);
    expect(laid.south!.height).toBeGreaterThanOrEqual(48);
    expect(laid.scrollWidth).toBeLessThanOrEqual(laid.viewport + 1);
    expect(laid.north!.gridArea).toContain('north');
    expect(await page.locator('[data-cardinal="North"]').getAttribute('data-token')).toBe(token('2'));
    expect(await page.locator('[data-cardinal="South"]').getAttribute('data-token')).toBe(token('1'));
  });

  it('keeps the same north and south positions when the stored direction is reversed', async () => {
    await render(page, (
      <CurbSideCrossSection
        confirmation={confirmation('east-west',
          { token: token('3'), cardinal: 'North' },
          { token: token('4'), cardinal: 'South' })}
        onSelect={() => {}}
        onCancel={() => {}}
        loading={false}
      />
    ));
    const laid = await boxes(page);
    expect(laid.north!.bottom).toBeLessThanOrEqual(laid.road!.y);
    expect(laid.south!.y).toBeGreaterThanOrEqual(laid.road!.bottom);
  });

  it('places west left and east right of a north-south road', async () => {
    await render(page, (
      <CurbSideCrossSection
        confirmation={confirmation('north-south',
          { token: token('5'), cardinal: 'East' },
          { token: token('6'), cardinal: 'West' })}
        onSelect={() => {}}
        onCancel={() => {}}
        loading={false}
      />
    ));
    const laid = await boxes(page);
    expect(laid.areas).toContain('west');
    expect(laid.areas).toContain('east');
    expect(laid.northMark!.y).toBeLessThan(laid.road!.y);
    expect(laid.west!.right).toBeLessThanOrEqual(laid.road!.x);
    expect(laid.east!.x).toBeGreaterThanOrEqual(laid.road!.right);
    expect(laid.west!.height).toBeGreaterThanOrEqual(48);
    expect(laid.east!.height).toBeGreaterThanOrEqual(48);
    expect(laid.scrollWidth).toBeLessThanOrEqual(laid.viewport + 1);
  });

  it('keeps west left and east right when the stored direction is reversed', async () => {
    await render(page, (
      <CurbSideCrossSection
        confirmation={confirmation('north-south',
          { token: token('7'), cardinal: 'West' },
          { token: token('8'), cardinal: 'East' })}
        onSelect={() => {}}
        onCancel={() => {}}
        loading={false}
      />
    ));
    const laid = await boxes(page);
    expect(laid.west!.right).toBeLessThanOrEqual(laid.road!.x);
    expect(laid.east!.x).toBeGreaterThanOrEqual(laid.road!.right);
  });

  it('shows no curb button for a pair the diagram cannot place', async () => {
    await render(page, (
      <CurbSideCrossSection
        confirmation={confirmation('east-west',
          { token: token('1'), cardinal: 'North' },
          { token: token('2'), cardinal: 'East' })}
        onSelect={() => {}}
        onCancel={() => {}}
        loading={false}
      />
    ));
    const laid = await boxes(page);
    expect(laid.choices).toBe(0);
    expect(laid.road).toBeNull();
  });
});
