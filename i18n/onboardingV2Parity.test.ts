import { describe, expect, it } from 'vitest';
import en from './en';
import es from './es';

const keysFor = (dict: Record<string, string>) =>
  Object.keys(dict).filter(k => k.startsWith('onboarding_v2.') || k.startsWith('map.explore_chip') || k.startsWith('map.vehicle_hint')).sort();

describe('Onboarding 2.0 copy', () => {
  it('English and Spanish keys stay in parity', () => {
    expect(keysFor(es)).toEqual(keysFor(en));
    expect(keysFor(en).length).toBeGreaterThanOrEqual(25);
  });

  it('every string is translated and placeholders match', () => {
    for (const key of keysFor(en)) {
      const e = (en as Record<string, string>)[key];
      const s = (es as Record<string, string>)[key];
      expect(e.trim(), key).not.toBe('');
      expect(s.trim(), key).not.toBe('');
      const ph = (v: string) => (v.match(/\{\w+\}/g) ?? []).sort();
      expect(ph(s), key).toEqual(ph(e));
    }
  });

  it('keeps the approved non-reservation disclosure (pending legal review D27)', () => {
    expect(en['onboarding_v2.disclosure']).toBe('A Ping lets you know a spot may be opening up. Parking isn’t guaranteed.');
    expect(es['onboarding_v2.disclosure'].toLowerCase()).toContain('no se garantiza el estacionamiento');
  });

  it('never claims the example street is live activity', () => {
    for (const key of ['onboarding_v2.alt_arrive', 'onboarding_v2.alt_demo', 'onboarding_v2.alt_choose']) {
      expect((en as Record<string, string>)[key]).toMatch(/^Example scene/);
      expect((es as Record<string, string>)[key]).toMatch(/^Escena de ejemplo/);
    }
  });

  it('labels the shortened sign-up as three steps', () => {
    expect(en['onboarding_v2.signup_step']).toBe('Step {n} of 3');
    expect(es['onboarding_v2.signup_step']).toBe('Paso {n} de 3');
  });
});
