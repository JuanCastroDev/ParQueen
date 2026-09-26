import { describe, expect, it } from 'vitest';
import en from './en';
import es from './es';

describe('Street Intelligence consumer copy', () => {
  it('uses one calm unsupported sentence in both languages', () => {
    expect(en['street_intel.could_not_verify']).toBe(
      'ParQueen could not verify the curb and parking rules here.',
    );
    expect(es['street_intel.could_not_verify']).toBe(
      'ParQueen no pudo verificar el bordillo ni las reglas de estacionamiento aquí.',
    );
  });

  it('keeps consumer status copy free of provider and review terminology', () => {
    for (const value of [
      en['street_intel.could_not_verify'],
      es['street_intel.could_not_verify'],
      en['street_intel.verifying_curb'],
      es['street_intel.verifying_curb'],
    ]) {
      expect(value).not.toMatch(/provider|source|updated|review|confidence|proveedor|fuente|actualizad|revisi[oó]n|confianza/i);
    }
  });
});
