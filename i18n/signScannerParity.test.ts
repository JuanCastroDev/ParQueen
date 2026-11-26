import { describe, expect, it } from 'vitest';
import en from './en';
import es from './es';

const E = en as Record<string, string>;
const S = es as Record<string, string>;
const keysFor = (dict: Record<string, string>) => Object.keys(dict).filter(k => k.startsWith('scanner.')).sort();

describe('Sign Scanner copy', () => {
  it('English and Spanish keys stay in parity', () => {
    expect(keysFor(S)).toEqual(keysFor(E));
    expect(keysFor(E).length).toBeGreaterThanOrEqual(60);
  });

  it('every string is translated and placeholders match', () => {
    for (const key of keysFor(E)) {
      expect(E[key].trim(), key).not.toBe('');
      expect(S[key].trim(), key).not.toBe('');
      const ph = (v: string) => (v.match(/\{\w+\}/g) ?? []).sort();
      expect(ph(S[key]), key).toEqual(ph(E[key]));
    }
  });

  it('has no untranslated English left in Spanish', () => {
    // Identical strings are only allowed where they are not words (none today).
    const identical = keysFor(E).filter(k => E[k] === S[k]);
    expect(identical).toEqual([]);
  });

  it('keeps the interpretation boundary explicit in both languages', () => {
    expect(E['scanner.boundary_strong']).toBe('An AI reading of your photo, not verified legal permission.');
    expect(S['scanner.boundary_strong'].toLowerCase()).toContain('no un permiso legal verificado');
  });

  it('hedges every verdict and never promises legality or safety', () => {
    for (const key of ['scanner.verdict_yes', 'scanner.verdict_no']) {
      expect(E[key]).toMatch(/appears/);
      expect(S[key]).toMatch(/^Parece/);
    }
    for (const key of keysFor(E)) {
      expect(E[key], key).not.toMatch(/guarantee|you can park here|safe to park|no ticket/i);
      expect(S[key], key).not.toMatch(/garantiza|puedes parquear aquí|sin multa/i);
    }
  });

  it('carries no retired tools', () => {
    for (const key of keysFor(E)) {
      expect(E[key], key).not.toMatch(/hydrant|am i safe|parking tools/i);
      expect(S[key], key).not.toMatch(/hidrante|estoy seguro|herramientas de parqueo/i);
    }
  });
});
