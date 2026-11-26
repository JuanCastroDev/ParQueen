import { beforeAll, describe, expect, it } from 'vitest';

beforeAll(() => {
  const store = new Map<string, string>();
  (globalThis as any).localStorage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => store.set(key, value),
  };
});

describe('Street Intelligence safety-copy language parity', () => {
  it('communicates the same parking and AI limitations in English and Spanish', async () => {
    const { setLang, t } = await import('./index');

    setLang('en');
    expect(t('street_intel.decision_caution')).toBe('Check posted signs and current NYC rules before parking.');
    // The Sign Scanner's AI limitation (replaced assistant.disclaimer when the Parking Tools hub was retired).
    expect(t('scanner.boundary_strong')).toBe('An AI reading of your photo, not verified legal permission.');
    expect(t('scanner.boundary_body')).toBe('It can be incomplete or wrong. The posted signs, curb markings, and local rules always apply.');

    setLang('es');
    expect(t('street_intel.decision_caution')).toBe('Revisa las señales publicadas y las reglas actuales de NYC antes de estacionarte.');
    expect(t('scanner.boundary_strong')).toBe('Es una lectura de tu foto hecha con IA, no un permiso legal verificado.');
    expect(t('scanner.boundary_body')).toBe('Puede estar incompleta o equivocada. Siempre aplican las señales publicadas, las marcas de la acera y las reglas locales.');
  });
});
