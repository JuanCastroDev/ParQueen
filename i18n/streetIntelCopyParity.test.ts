import { describe, expect, it } from 'vitest';
import en from './en';
import es from './es';

describe('Street Intelligence English/Spanish key parity', () => {
  const enKeys = Object.keys(en).filter(key => key.startsWith('street_intel.')).sort();
  const esKeys = Object.keys(es).filter(key => key.startsWith('street_intel.')).sort();

  it('has the same street_intel keys in English and Spanish', () => {
    expect(esKeys).toEqual(enKeys);
  });

  it('does not leave English source text in Spanish street_intel strings', () => {
    for (const key of enKeys) {
      const english = en[key];
      const spanish = es[key];
      expect(typeof spanish).toBe('string');
      expect(spanish).not.toBe('');
      if (key === 'street_intel.source_park_nyc' || key === 'street_intel.source_sweepnyc') continue;
      expect(spanish).not.toBe(english);
    }
  });
});
