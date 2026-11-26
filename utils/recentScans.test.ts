import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  const store = new Map<string, string>();
  (globalThis as any).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => store.set(k, v),
    removeItem: (k: string) => store.delete(k),
  };
});

import { clearRecentScans, loadRecentScans, recordScan, restoreRecentScans } from './recentScans';

beforeEach(() => clearRecentScans());

/* Ported from the retired AssistantView.scanner.test.tsx "recentScans store" block. */
describe('recentScans store', () => {
  it('keeps only title, verdict and timestamp — never a photo or location', () => {
    const list = recordScan({ status: 'YES', explanation: 'Parking allowed.\nDetails here.' } as any);
    expect(list).toHaveLength(1);
    expect(Object.keys(list[0]).sort()).toEqual(['id', 'status', 'title', 'ts']);
    expect(list[0].title).toBe('Parking allowed.');
  });

  it('does not record failed reads', () => {
    recordScan({ status: 'ERROR', explanation: 'nope' } as any);
    expect(loadRecentScans()).toHaveLength(0);
  });

  it('records CONDITIONAL results like any other interpretation', () => {
    recordScan({ status: 'CONDITIONAL', explanation: 'Depends on the day.' } as any);
    expect(loadRecentScans()[0].status).toBe('CONDITIONAL');
  });

  it('caps history at five entries, newest first', () => {
    for (let i = 1; i <= 7; i++) recordScan({ status: 'YES', explanation: `Scan ${i}` } as any);
    const list = loadRecentScans();
    expect(list).toHaveLength(5);
    expect(list[0].title).toBe('Scan 7');
  });

  it('survives unusable storage without throwing', () => {
    const original = (globalThis as any).localStorage;
    (globalThis as any).localStorage = {
      getItem() { throw new Error('blocked'); },
      setItem() { throw new Error('blocked'); },
      removeItem() { throw new Error('blocked'); },
    };
    expect(() => loadRecentScans()).not.toThrow();
    expect(loadRecentScans()).toEqual([]);
    expect(() => restoreRecentScans([])).not.toThrow();
    (globalThis as any).localStorage = original;
  });
});

describe('restoreRecentScans (Undo after Clear)', () => {
  it('puts back exactly what was cleared', () => {
    recordScan({ status: 'YES', explanation: 'A' } as any);
    recordScan({ status: 'NO', explanation: 'B' } as any);
    const before = loadRecentScans();
    clearRecentScans();
    expect(loadRecentScans()).toEqual([]);
    expect(restoreRecentScans(before)).toEqual(before);
    expect(loadRecentScans()).toEqual(before);
  });

  it('never widens what is stored', () => {
    const restored = restoreRecentScans([
      { id: '1', status: 'YES', title: 'ok', ts: 1, photo: 'data:image/png;base64,AAA', lat: 40.7 } as any,
      { id: '2', status: 'ERROR', title: 'bad', ts: 2 } as any,
      { id: 3, status: 'NO', title: 'bad id', ts: 3 } as any,
    ]);
    expect(restored).toEqual([{ id: '1', status: 'YES', title: 'ok', ts: 1 }]);
    expect(Object.keys(loadRecentScans()[0]).sort()).toEqual(['id', 'status', 'title', 'ts']);
  });
});
