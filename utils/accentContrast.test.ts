import { readFileSync, readdirSync, statSync } from 'fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'path';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const palette = require('tailwindcss/colors') as {
    slate: Record<string, string>;
    [family: string]: Record<string, string>;
};

// Guards the accent-role palette. Before it existed, every screen picked its own
// Tailwind -400 shade for "success"/"danger"/"info" text; those are tuned for a
// dark page and measured 1.5-2.5:1 once light mode shipped. The rule now is:
// one token per meaning, and the raw shades never come back as text colours.
const root = resolve(__dirname, '..');
const css = readFileSync(resolve(root, 'index.css'), 'utf-8');

const block = (selector: string) => {
    const start = css.indexOf(selector);
    return css.slice(start, css.indexOf('}', start));
};
const token = (src: string, name: string) => src.match(new RegExp(`${name}:\\s*([^;]+);`))![1].trim();
const rgba = (v: string): number[] => {
    if (v.startsWith('#')) return [1, 3, 5].map(i => parseInt(v.slice(i, i + 2), 16)).concat(1);
    const n = v.match(/[\d.]+/g)!.map(Number);
    return [n[0], n[1], n[2], n[3] ?? 1];
};
const lin = (c: number) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
const lum = (c: number[]) => 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2]);
const contrast = (fgValue: string, bgValue: string) => {
    const fg = rgba(fgValue), bg = rgba(bgValue);
    const mixed = [0, 1, 2].map(i => fg[i] * fg[3] + bg[i] * (1 - fg[3]));
    const a = lum(mixed), b = lum(bg);
    return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
};

function sourceFiles(dir: string, out: string[] = []): string[] {
    for (const name of readdirSync(dir)) {
        if (name === 'node_modules' || name.startsWith('.') || name === 'dist' || name === 'functions') continue;
        const p = join(dir, name);
        if (statSync(p).isDirectory()) sourceFiles(p, out);
        else if (p.endsWith('.tsx') && !p.endsWith('.test.tsx')) out.push(p);
    }
    return out;
}

const ROLES = ['--color-accent', '--color-info', '--color-success', '--color-danger', '--color-warning'];
const CROWNS = Array.from({ length: 8 }, (_, i) => `--crown-${i}-text`);

describe('accent role contrast', () => {
    const light = block(':root {');
    const dark = block('.dark {');

    it.each([...ROLES, ...CROWNS])('light %s clears 4.5:1 on the page and on white', name => {
        const fg = token(light, name);
        expect(contrast(fg, token(light, '--color-bg'))).toBeGreaterThanOrEqual(4.5);
        expect(contrast(fg, '#ffffff')).toBeGreaterThanOrEqual(4.5);
    });

    it.each([...ROLES, ...CROWNS])('dark %s clears 4.5:1 on the page and surface colours', name => {
        const fg = token(dark, name);
        expect(contrast(fg, token(dark, '--color-bg'))).toBeGreaterThanOrEqual(4.5);
        expect(contrast(fg, token(dark, '--color-surface'))).toBeGreaterThanOrEqual(4.5);
    });

    it('white text clears 4.5:1 on both ends of the brand fill, in either theme', () => {
        // --color-brand/-2 are deliberately not overridden in .dark: the fill carries
        // white text in both themes, so one value has to satisfy both.
        for (const name of ['--color-brand', '--color-brand-2']) {
            expect(dark).not.toContain(name + ':');
            expect(contrast('#ffffff', token(light, name))).toBeGreaterThanOrEqual(4.5);
        }
    });

    it('no view sets text to a raw dark-tuned accent shade', () => {
        const BANNED = /(?:^|[\s"'`:])text-(?:blue|sky|emerald|green|red|rose|amber|yellow)-(?:300|400)\b|text-\[#(?:38bdf8|7dd3fc|1e75ff)\](?!\/)/;
        const NAMED = /text-(blue|sky|emerald|green|red|rose|amber|yellow)-(300|400)\b/;
        const ARBITRARY = /text-\[#((?:38bdf8|7dd3fc|1e75ff))\](?!\/)/i;
        const DARK_BG = /\bbg-(slate-950|slate-900|black)(?:\/(\d{1,3}))?\b/g;
        const LATER_LIGHT_BG = /\bbg-(?:white|slate-(?:50|100|200)|gray-50)\b/;
        const offenders: string[] = [];
        const measured: string[] = [];
        for (const file of sourceFiles(root)) {
            const lines = readFileSync(file, 'utf-8').split('\n');
            lines.forEach((line, i) => {
                if (!BANNED.test(line)) return;
                const named = line.match(NAMED);
                const arbitrary = line.match(ARBITRARY);
                const fg = named
                    ? palette[named[1]]?.[named[2]]
                    : arbitrary
                        ? `#${arbitrary[1].toLowerCase()}`
                        : '';
                const windowText = lines.slice(Math.max(0, i - 15), i + 1).join('\n');
                DARK_BG.lastIndex = 0;
                const backgrounds = [...windowText.matchAll(DARK_BG)];
                const background = backgrounds.at(-1);
                const afterBackground = background
                    ? windowText.slice(windowText.lastIndexOf(background[0]) + background[0].length)
                    : windowText;
                const alpha = background?.[2] ? Number(background[2]) : 100;
                const solid = background?.[1] === 'black'
                    ? '#000000'
                    : background
                        ? palette.slate[background[1].slice('slate-'.length)]
                        : '';
                const usable = Boolean(
                    fg?.startsWith('#')
                    && fg.length === 7
                    && background
                    && Number.isInteger(alpha)
                    && alpha >= 1
                    && alpha <= 100
                    && solid?.startsWith('#')
                    && solid.length === 7
                    && !LATER_LIGHT_BG.test(afterBackground),
                );
                if (!usable) {
                    offenders.push(`${file.slice(root.length + 1)}:${i + 1}`);
                    return;
                }
                const [r, g, b] = rgba(solid);
                const mix = [r, g, b].map((channel) => Math.round(channel * (alpha / 100) + 255 * (1 - alpha / 100)));
                const ratio = contrast(fg, `rgb(${mix[0]}, ${mix[1]}, ${mix[2]})`);
                if (ratio < 4.5) {
                    offenders.push(`${file.slice(root.length + 1)}:${i + 1} (${ratio.toFixed(2)}:1 on explicit dark surface)`);
                    return;
                }
                measured.push(`${file.slice(root.length + 1)}:${i + 1} ${ratio.toFixed(2)}:1`);
            });
        }
        expect(offenders).toEqual([]);
        expect(measured.length).toBeGreaterThan(0);
    });
});
