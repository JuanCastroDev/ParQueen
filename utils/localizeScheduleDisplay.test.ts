import { readFileSync } from 'node:fs';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

beforeAll(() => {
  const store = new Map<string, string>();
  (globalThis as any).localStorage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => store.set(key, value),
    removeItem: (key: string) => store.delete(key),
  };
});

afterEach(async () => {
  const { setLang } = await import('../i18n');
  setLang('en');
});

describe('localizeScheduleWeekday', () => {
  it('switches the displayed weekday with the app language without changing the stored day', async () => {
    const { setLang } = await import('../i18n');
    const { localizeScheduleWeekday } = await import('./localizeScheduleDisplay');
    expect(localizeScheduleWeekday('Thursday')).toBe('Thursday');
    setLang('es');
    expect(localizeScheduleWeekday('Thursday')).toBe('jueves');
    setLang('en');
    expect(localizeScheduleWeekday('Thursday')).toBe('Thursday');
  });

  it('localizes the displayed clock period with the same language', async () => {
    const { setLang } = await import('../i18n');
    const { localizeScheduleClock } = await import('./localizeScheduleDisplay');
    setLang('es');
    expect(localizeScheduleClock('8:30 AM')).toBe('8:30 a. m.');
  });

  it('is what Parking Check uses for the displayed weekday', () => {
    const source = readFileSync(new URL('../views/assistant/ParkingCheckTool.tsx', import.meta.url), 'utf8');
    expect(source).toContain('localizeScheduleWeekday(street.safeUntil.nextDay)');
    expect(source).not.toContain(".replace('{day}', street.safeUntil.nextDay)");
  });
});
