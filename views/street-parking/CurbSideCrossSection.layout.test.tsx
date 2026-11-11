import React from 'react';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { chromium, type Browser, type Page } from '@playwright/test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CurbSideCrossSection } from './CurbSideCrossSection';
import type { SideConfirmation } from '../../utils/canonicalCurbClient';
import { sampleSideConfirmationToken } from '../../utils/sideConfirmationTokenFixture';

const token = (rank: string) => sampleSideConfirmationToken(rank);
const css = (() => {
  const source = readFileSync(new URL('../../index.css', import.meta.url), 'utf8');
  const start = source.indexOf('.pq-curb-selector,');
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

function pageHtml(markup: string, width = 320) {
  return `<!doctype html><html><head><style>
    body { margin: 0; width: ${width}px; }
    ${css}
  </style></head><body>${markup}</body></html>`;
}

async function render(page: Page, node: React.ReactElement, width = 320) {
  await page.setContent(pageHtml(renderToStaticMarkup(node), width));
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
  }, 30_000);

  it('places north above and south below an east-west road on a narrow screen', async () => {
    await render(page, (
      <CurbSideCrossSection
        confirmation={confirmation('east-west',
          { token: token('1'), cardinal: 'South' },
          { token: token('2'), cardinal: 'North' })}
        onSelect={() => {}}
        onCancel={() => {}}
        loading={false} allowDiagonalCurbDrawing
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
    expect(await page.locator('[data-cardinal="North"]').getAttribute('data-cardinal')).toBe('North');
    expect(await page.locator('[data-cardinal="South"]').getAttribute('data-cardinal')).toBe('South');
    const html = await page.content();
    expect(html).not.toContain('data-token');
    expect(html).not.toContain(token('1'));
    expect(html).not.toContain(token('2'));
  });

  it('keeps the same north and south positions when the stored direction is reversed', async () => {
    await render(page, (
      <CurbSideCrossSection
        confirmation={confirmation('east-west',
          { token: token('3'), cardinal: 'North' },
          { token: token('4'), cardinal: 'South' })}
        onSelect={() => {}}
        onCancel={() => {}}
        loading={false} allowDiagonalCurbDrawing
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
        loading={false} allowDiagonalCurbDrawing
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
        loading={false} allowDiagonalCurbDrawing
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
        loading={false} allowDiagonalCurbDrawing
      />
    ));
    const laid = await boxes(page);
    expect(laid.choices).toBe(0);
    expect(laid.road).toBeNull();
  });

  it('keeps a near-vertical oblique pair inside a 320px screen', async () => {
    const oblique: SideConfirmation = {
      streetName: 'Diagonal Avenue',
      orientation: { north: 'up', axis: 'oblique', bearingDegrees: 21 },
      curbs: [
        { token: token('w'), cardinal: 'West' },
        { token: token('e'), cardinal: 'East' },
      ],
    };
    await render(page, (
      <CurbSideCrossSection confirmation={oblique} onSelect={() => {}} onCancel={() => {}} loading={false} allowDiagonalCurbDrawing />
    ));
    const laid = await boxes(page);
    expect(laid.northMark!.y).toBeLessThan(laid.road!.y);
    expect(laid.west!.x + laid.west!.width / 2).toBeLessThan(laid.east!.x + laid.east!.width / 2);
    expect(laid.west!.x).toBeGreaterThanOrEqual(-1);
    expect(laid.east!.right).toBeLessThanOrEqual(laid.viewport + 1);
    expect(laid.scrollWidth).toBeLessThanOrEqual(laid.viewport + 1);
    expect(laid.west!.height).toBeGreaterThanOrEqual(48);
    const html = await page.content();
    expect(html).not.toContain(token('w'));
    expect(html).not.toContain('reserved');
  });

  it('keeps one-way Left and Right apart on a Samsung portrait and landscape screen', async () => {
    const oneWay: SideConfirmation = {
      streetName: 'Maran Place',
      orientation: { north: 'up', axis: 'oblique', bearingDegrees: 321 },
      curbs: [
        { token: token('sw'), cardinal: 'Southwest', drivingSide: 'left' },
        { token: token('ne'), cardinal: 'Northeast', drivingSide: 'right' },
      ],
    };
    const node = (
      <CurbSideCrossSection confirmation={oneWay} onSelect={() => {}} onCancel={() => {}} loading={false} allowDiagonalCurbDrawing />
    );
    for (const viewport of [
      { width: 360, height: 800, label: 'portrait' },
      { width: 800, height: 360, label: 'landscape' },
    ]) {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await render(page, node, viewport.width);
      const laid = await page.evaluate(() => {
        const rect = (selector: string) => {
          const element = document.querySelector(selector);
          if (!element) return null;
          const box = element.getBoundingClientRect();
          return {
            x: box.x, y: box.y, right: box.right, bottom: box.bottom,
            width: box.width, height: box.height,
            gridArea: getComputedStyle(element).gridArea,
          };
        };
        return {
          left: rect('[data-driving-side="left"]'),
          right: rect('[data-driving-side="right"]'),
          cancel: rect('.pq-curb-side-cancel'),
          road: rect('.pq-curb-side-road'),
          north: rect('.pq-curb-side-north'),
          compassChoices: document.querySelectorAll('.pq-curb-side-choice').length,
          viewport: document.documentElement.clientWidth,
          scrollWidth: document.documentElement.scrollWidth,
        };
      });
      expect(laid.left, viewport.label).not.toBeNull();
      expect(laid.right, viewport.label).not.toBeNull();
      expect(laid.cancel, viewport.label).not.toBeNull();
      expect(laid.compassChoices, viewport.label).toBe(0);
      expect(laid.road, viewport.label).toBeNull();
      expect(laid.north, viewport.label).toBeNull();
      expect(laid.left!.right, viewport.label).toBeLessThanOrEqual(laid.right!.x);
      expect(Math.abs(laid.left!.width - laid.right!.width), viewport.label).toBeLessThan(2);
      expect(laid.left!.width, viewport.label).toBeGreaterThanOrEqual(44);
      expect(laid.right!.width, viewport.label).toBeGreaterThanOrEqual(44);
      expect(laid.left!.height, viewport.label).toBeGreaterThanOrEqual(44);
      expect(laid.right!.height, viewport.label).toBeGreaterThanOrEqual(44);
      expect(laid.left!.gridArea, viewport.label).not.toContain('west');
      expect(laid.right!.gridArea, viewport.label).not.toContain('east');
      expect(laid.cancel!.y, viewport.label).toBeGreaterThanOrEqual(laid.left!.bottom - 1);
      expect(laid.cancel!.y, viewport.label).toBeGreaterThanOrEqual(laid.right!.bottom - 1);
      expect(laid.scrollWidth, viewport.label).toBeLessThanOrEqual(laid.viewport + 1);
      const html = await page.content();
      expect(html, viewport.label).toContain('Facing the direction of traffic');
      expect(html, viewport.label).not.toContain('Maran Place');
    }
  });
});
