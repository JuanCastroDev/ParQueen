import { beforeAll, describe, expect, it } from 'vitest';
import { PARQUEEN_MARK_OFFSET, PARQUEEN_MARK_TRANSFORM, PARQUEEN_MARK_PATH, PIN_PATH, PIN_TIP, PIN_VIEWBOX, PIN_VIEWBOX_HEIGHT, pinHeightForWidth } from './parqueenMark';

// The root vitest environment is node (no DOM library installed), so the marker
// factories get a minimal element stub and the assertions run on the generated markup.
type StubEl = { style: Record<string, string>; dataset: Record<string, string>; innerHTML: string };
let createMarkerElement: (scheduled?: boolean, reportedMs?: number) => StubEl;
let createStackMarkerElement: (count: number, hasAvailableNow: boolean) => StubEl;
let formatStackCount: (count: number) => string;
let createMarkerSized: (s: boolean, r: number, o: { size?: number }) => StubEl;
let createStackSized: (n: number, h: boolean, o: { size?: number }) => StubEl;
let HIT_AREA_SIZE: number; let PIN_SIZE: number;
let stackBadgeGeometry: (size: number, label: string) => { height: number; font: number; left: number; bottom: number; top: number };

beforeAll(async () => {
  (globalThis as any).document ??= { createElement: (): StubEl => ({ style: {}, dataset: {}, innerHTML: '' }) };
  const utils = await import('./utils');
  createMarkerElement = utils.createMarkerElement as any;
  createStackMarkerElement = utils.createStackMarkerElement as any;
  formatStackCount = utils.formatStackCount;
  createMarkerSized = utils.createMarkerElement as any;
  createStackSized = utils.createStackMarkerElement as any;
  stackBadgeGeometry = utils.stackBadgeGeometry;
  HIT_AREA_SIZE = utils.HIT_AREA_SIZE; PIN_SIZE = utils.PIN_SIZE;
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
    expect(wrapperSize(now)).toEqual(['38', String(pinHeightForWidth(38))]);
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
      expect(box(single.innerHTML)).toEqual(['38', String(pinHeightForWidth(38))]);
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

  describe.each([46, 38, 34, 32])('pin size %ipx', (size) => {
    const box = (html: string) => html.match(/data-pin-box="true" style="width:([\d.]+)px;height:([\d.]+)px;/)?.slice(1).map(Number);
    const fgInner = (html: string) => (html.match(/<svg data-pin-fg="true"[\s\S]*?<\/svg>/)?.[0] ?? '').replace(/^<svg[^>]*>/, '');

    it('scales the whole pin proportionally from one width', () => {
      for (const el of [createMarkerSized(false, 0, { size }), createStackSized(12, true, { size })]) {
        expect(box(el.innerHTML)).toEqual([size, (size * PIN_VIEWBOX_HEIGHT) / 40]);
        expect(el.innerHTML).toContain(`viewBox="${PIN_VIEWBOX}"`);
      }
      const rings = createMarkerSized(false, 0, { size }).innerHTML.match(/map-pin-pulse" style="width:(\d+(?:\.\d+)?)px/g);
      expect(rings).toHaveLength(2);
      expect(rings![0]).toContain(`width:${size}px`);
    });

    it('keeps the mark transform in pin units and single/stack foregrounds identical', () => {
      const single = createMarkerSized(true, 0, { size }).innerHTML;
      const stack = createStackSized(150, false, { size }).innerHTML;
      expect(single).toContain(`data-parqueen-mark="true" transform="${PARQUEEN_MARK_TRANSFORM}"`);
      expect(fgInner(stack)).toBe(fgInner(single));
      expect(fgInner(single)).toBe(fgInner(createMarkerSized(true, 0, {}).innerHTML));
    });

    it('keeps the badge legible, capped at 99+, and anchored by its bottom-left corner outside the mark', () => {
      const stack = createStackSized(1500, true, { size });
      expect(stack.innerHTML).toMatch(/data-stack-badge="true"[^>]*>99\+<\/div>/);
      expect(stack.dataset.stackCount).toBe('1500');
      for (const label of ['12', '99+']) {
        const g = stackBadgeGeometry(size, label);
        expect(g.font).toBeGreaterThanOrEqual(9);
        expect(g.height).toBeGreaterThanOrEqual(15);
        const u = size / 40;
        // same anchor for every label: wider pills grow rightward, away from the mark
        expect(g.left).toBeCloseTo(30 * u, 2);
        expect(g.bottom).toBeCloseTo(9.5 * u, 2);
        expect(g.top).toBeCloseTo(g.bottom - g.height, 2);
        expect(stack.innerHTML).toContain(`left:${g.left}px;top:${g.top}px;pointer-events:auto;`);
        expect(stack.innerHTML).not.toMatch(/data-stack-badge[^>]*translate\(-50%/);
      }
    });
  });

  describe('38px default with invisible tap target', () => {
    const hit = (html: string) => html.match(/<div data-marker-hit-area="true"[^>]*style="([^"]*)"/)?.[1] ?? '';
    const num = (style: string, prop: string) => Number(style.match(new RegExp(`(?:^|;)${prop}:(-?[\\d.]+)px`))?.[1]);
    const all = () => [createMarkerElement(false), createMarkerElement(true), createStackMarkerElement(12, true), createStackMarkerElement(150, false)];

    it('defaults every marker to a 38px pin', () => {
      expect(PIN_SIZE).toBe(38);
      for (const el of all()) expect(el.innerHTML).toMatch(/data-pin-box="true" style="width:38px;height:43.7px;/);
    });

    it('adds one transparent 48x48 (>=44) hit area centred on the pin head, outside the pin box', () => {
      expect(HIT_AREA_SIZE).toBe(48);
      for (const el of all()) {
        const html = el.innerHTML;
        expect(html.match(/data-marker-hit-area/g)).toHaveLength(1);
        const s = hit(html);
        expect(s).toContain('position:absolute');
        expect(s).toContain('background:transparent');
        expect(s).toContain('pointer-events:auto');
        expect(num(s, 'width')).toBeGreaterThanOrEqual(44);
        expect(num(s, 'width')).toBe(48);
        expect(num(s, 'height')).toBe(48);
        const u = 38 / 40;
        expect(num(s, 'left') + 24).toBeCloseTo(20 * u, 2);
        expect(num(s, 'top') + 24).toBeCloseTo(19 * u, 2);
        // covers the whole head circle (r = 18 units)
        expect(num(s, 'left')).toBeLessThanOrEqual(2 * u);
        expect(num(s, 'left') + 48).toBeGreaterThanOrEqual(38 * u);
        expect(num(s, 'top')).toBeLessThanOrEqual(1 * u);
        // not inside the pin box, so it cannot affect the box that defines the anchor
        const box = html.match(/<div data-pin-box="true"[\s\S]*?<\/svg>\s*(?:<div data-stack-badge[\s\S]*?<\/div>\s*)?<\/div>/)?.[0] ?? '';
        expect(box).not.toContain('data-marker-hit-area');
        expect(el.style.position).toBeUndefined();
      }
    });

    it('pins the badge by its left edge so wider labels (9, 12, 99, 99+) grow away from the mark', () => {
      // No DOM here, so width is an ESTIMATE (glyph ~0.62em + padding + border); the actual rendered widths
      // and pixel clearances are measured in Chromium by .ui-evidence/shoot-qa.mjs (16 / 17.75 / 18.8 / 25.22px).
      const badges = [9, 12, 99, 1500].map((n) => {
        const html = createStackMarkerElement(n, true).innerHTML;
        const s = html.match(/<div data-stack-badge="true" style="([^"]*)"[^>]*>([^<]*)<\/div>/)!;
        const px = (prop: string) => Number(s[1].match(new RegExp(`(?:^|;)${prop}:(-?[\\d.]+)px`))![1]);
        const font = Number(s[1].match(/font:900 ([\d.]+)px/)![1]);
        const estWidth = Math.max(px('height'), s[2].length * 0.62 * font + 2 * 3 + 3);
        expect(s[1]).not.toContain('translate(');
        return { label: s[2], left: px('left'), top: px('top'), right: px('left') + estWidth };
      });
      expect(badges.map((b) => b.label)).toEqual(['9', '12', '99', '99+']);
      for (const b of badges) {
        expect(b.left).toBe(badges[0].left);
        expect(b.top).toBe(badges[0].top);
      }
      expect(badges[3].right).toBeGreaterThan(badges[1].right);
      expect(badges[3].right).toBeGreaterThan(badges[0].right);
    });
  });
});
