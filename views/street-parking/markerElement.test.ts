import { beforeAll, describe, expect, it } from 'vitest';
import { PARQUEEN_MARK_OFFSET, PARQUEEN_MARK_TRANSFORM, PARQUEEN_MARK_PATH, PIN_PATH, PIN_TIP, PIN_VIEWBOX, PIN_VIEWBOX_HEIGHT, pinHeightForWidth } from './parqueenMark';

// The root vitest environment is node (no DOM library installed), so the marker
// factories get a minimal element stub and the assertions run on the generated markup.
type StubEl = { style: Record<string, string>; dataset: Record<string, string>; innerHTML: string };
let createMarkerElement: (scheduled?: boolean, reportedMs?: number) => StubEl;
let createStackMarkerElement: (count: number, hasAvailableNow: boolean) => StubEl;
let formatStackCount: (count: number) => string;

beforeAll(async () => {
  (globalThis as any).document ??= { createElement: (): StubEl => ({ style: {}, dataset: {}, innerHTML: '' }) };
  const utils = await import('./utils');
  createMarkerElement = utils.createMarkerElement as any;
  createStackMarkerElement = utils.createStackMarkerElement as any;
  formatStackCount = utils.formatStackCount;
});

const attr = (html: string, marker: string, name: string) =>
  html.match(new RegExp(`<[^>]*${marker}[^>]*\\s${name}="([^"]*)"`))?.[1]
  ?? html.match(new RegExp(`<[^>]*\\s${name}="([^"]*)"[^>]*${marker}`))?.[1];
const body = (html: string) => html.match(/<path data-pin-body="true" d="([^"]*)" fill="([^"]*)"/);
const mark = (html: string) => html.match(/data-parqueen-mark="true"[^>]*><path d="([^"]*)" fill="([^"]*)"/);
const wrapperSize = (html: string) => html.match(/width:(\d+(?:\.\d+)?)px;height:(\d+(?:\.\d+)?)px;flex-shrink:0/)?.slice(1);

describe('branded ping markers', () => {
  it('Leaving Now and Leaving Later share the same silhouette, mark and size', () => {
    const now = createMarkerElement(false, Date.now() - 60_000).innerHTML;
    const later = createMarkerElement(true, Date.now() - 60_000).innerHTML;
    for (const html of [now, later]) {
      expect(html).toContain(`viewBox="${PIN_VIEWBOX}"`);
      expect(body(html)?.[1]).toBe(PIN_PATH);
      expect(mark(html)?.[1]).toBe(PARQUEEN_MARK_PATH);
      expect(mark(html)?.[2]).toBe('#ffffff');
    }
    expect(wrapperSize(now)).toEqual(['46', String(pinHeightForWidth(46))]);
    expect(wrapperSize(later)).toEqual(wrapperSize(now));
    expect(attr(now, 'data-pin-body', 'fill')).toBe('#1e75ff');
  });

  it('uses blue for Now and yellow for Later and keeps dataset.scheduled', () => {
    const now = createMarkerElement(false);
    const later = createMarkerElement(true);
    expect(body(now.innerHTML)?.[2]).toBe('#1e75ff');
    expect(body(later.innerHTML)?.[2]).toBe('#eab308');
    expect(now.dataset.scheduled).toBe('false');
    expect(later.dataset.scheduled).toBe('true');
  });

  it('has no clock, square parking sign or text P', () => {
    for (const s of [false, true]) {
      const html = createMarkerElement(s).innerHTML;
      expect(html).not.toMatch(/<(rect|text|circle|line)\b/);
    }
  });

  it('keeps pulse rings for Now only and the aging fade', () => {
    expect(createMarkerElement(false).innerHTML.match(/map-pin-pulse/g)).toHaveLength(2);
    expect(createMarkerElement(true).innerHTML).not.toContain('map-pin-pulse');
    expect(createMarkerElement(false, Date.now() - 20 * 60_000).innerHTML).toContain('opacity:0.55');
  });

  it('places the pin tip on the bottom edge of the viewBox', () => {
    expect(PIN_TIP.y).toBe(PIN_VIEWBOX_HEIGHT);
    expect(PIN_PATH.startsWith(`M${PIN_TIP.x} ${PIN_TIP.y}`)).toBe(true);
    expect(PIN_PATH.endsWith(`${PIN_TIP.x} ${PIN_TIP.y}Z`)).toBe(true);
    expect(PIN_VIEWBOX).toBe(`0 0 40 ${PIN_VIEWBOX_HEIGHT}`);
  });

  it('stacks reuse the pin and mark and keep the count badge', () => {
    const html = createStackMarkerElement(7, false).innerHTML;
    expect(body(html)?.[1]).toBe(PIN_PATH);
    expect(body(html)?.[2]).toBe('#eab308');
    expect(mark(html)?.[1]).toBe(PARQUEEN_MARK_PATH);
    expect(html).toContain('data-stack-badge="true"');
    expect(html).toMatch(/data-stack-badge="true"[^>]*>7<\/div>/);
    expect(html).not.toContain('<rect');
    expect(body(createStackMarkerElement(12, true).innerHTML)?.[2]).toBe('#1e75ff');
  });

  it.each([
    [9, '9'], [12, '12'], [99, '99'], [100, '99+'], [120, '99+'], [1500, '99+'],
  ])('stack badge for %i reads %s and keeps the real count', (count, label) => {
    expect(formatStackCount(count)).toBe(label);
    for (const hasNow of [true, false]) {
      const el = createStackMarkerElement(count, hasNow);
      expect(el.innerHTML).toMatch(new RegExp(`data-stack-badge="true"[^>]*>${label.replace('+', '\\+')}</div>`));
      expect(el.dataset.stackCount).toBe(String(count));
    }
  });

  it('leaves positioning to mapbox-gl.css so markers anchor on their own coordinate', () => {
    // An inline position (previously 'relative') overrides .mapboxgl-marker { position:absolute }
    // and stacks markers in document flow, offsetting every marker after the first.
    for (const el of [createMarkerElement(false), createMarkerElement(true), createStackMarkerElement(3, true), createStackMarkerElement(150, false)]) {
      expect(el.style.position).toBeUndefined();
    }
  });

  it('single and stack markers place the mark with the one shared offset', () => {
    expect(PARQUEEN_MARK_TRANSFORM).toBe(`translate(${PARQUEEN_MARK_OFFSET.x} ${PARQUEEN_MARK_OFFSET.y}) scale(0.0805)`);
    expect(PARQUEEN_MARK_OFFSET).toEqual({ x: 8.03, y: 6.91 });
    for (const el of [createMarkerElement(false), createMarkerElement(true), createStackMarkerElement(4, true), createStackMarkerElement(150, false)]) {
      expect(el.innerHTML).toContain(`data-parqueen-mark="true" transform="${PARQUEEN_MARK_TRANSFORM}"`);
    }
  });

  it('stack foreground is geometrically identical to the single pin; decoration and badge are separate overlays', () => {
    const fgSvg = (html: string) => html.match(/<svg data-pin-fg="true"[\s\S]*?<\/svg>/)?.[0] ?? '';
    const box = (html: string) => html.match(/data-pin-box="true" style="width:([\d.]+)px;height:([\d.]+)px;/)?.slice(1);
    const pairs: [StubEl, StubEl][] = [[createMarkerElement(false), createStackMarkerElement(12, true)], [createMarkerElement(true), createStackMarkerElement(150, false)]];
    for (const [single, stack] of pairs) {
      const a = fgSvg(single.innerHTML), b = fgSvg(stack.innerHTML);
      expect(a).not.toBe('');
      expect(b.match(/viewBox="([^"]*)"/)?.[1]).toBe(PIN_VIEWBOX);
      expect(b.match(/viewBox="([^"]*)"/)?.[1]).toBe(a.match(/viewBox="([^"]*)"/)?.[1]);
      // same body path + colour, same mark transform and path, in the same order
      const inner = (svg: string) => svg.replace(/^<svg[^>]*>/, '');
      expect(inner(b)).toBe(inner(a));
      expect(box(stack.innerHTML)).toEqual(box(single.innerHTML));
      expect(box(single.innerHTML)).toEqual(['46', String(pinHeightForWidth(46))]);
      // decoration (back pins) and badge live outside the foreground svg and are absolutely positioned
      expect(b).not.toContain('translate(0,-');
      // back pins are offset straight up only (x = 0), centred on the foreground pin
      const deco = stack.innerHTML.match(/<svg data-stack-decoration="true"[\s\S]*?<\/svg>/)?.[0] ?? '';
      expect([...deco.matchAll(/transform="translate\(([^,]+),([^)]+)\)"/g)].map(m => [Number(m[1]), Number(m[2])])).toEqual([[0, -2.6], [0, -1.3]]);
      expect(deco).toContain(`viewBox="${PIN_VIEWBOX}"`);
      expect(b).not.toContain('data-stack-badge');
      expect(stack.innerHTML).toMatch(/<svg data-stack-decoration="true"[^>]*position:absolute;inset:0/);
      expect(stack.innerHTML).toMatch(/data-stack-badge="true" style="position:absolute;/);
      expect(single.innerHTML).not.toContain('data-stack-');
      for (const el of [single, stack]) {
        expect(el.style.position).toBeUndefined();
        expect(el.style.display).toBe('flex');
      }
    }
  });
});
