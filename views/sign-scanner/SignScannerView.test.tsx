import React from 'react';
import { readFileSync } from 'node:fs';
import TestRenderer, { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const analyzeParkingSign = vi.fn();
const startTimer = vi.fn();
const timerState: { timer: null | { expiresAt: number } } = { timer: null };

const windowListeners = vi.hoisted(() => {
  const store = new Map<string, string>();
  (globalThis as any).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => store.set(k, v),
    removeItem: (k: string) => store.delete(k),
  };
  const listeners = new Map<string, Set<() => void>>();
  (globalThis as any).window = {
    addEventListener: (type: string, fn: () => void) => {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(fn);
    },
    removeEventListener: (type: string, fn: () => void) => listeners.get(type)?.delete(fn),
  };
  return listeners;
});

vi.mock('../../services/geminiService', async () => {
  const actual = await vi.importActual<typeof import('../../services/geminiService')>('../../services/geminiService');
  return {
    SIGN_ANALYSIS_UNAVAILABLE_EXPLANATION: actual.SIGN_ANALYSIS_UNAVAILABLE_EXPLANATION,
    SIGN_ANALYSIS_UNREADABLE_EXPLANATION: actual.SIGN_ANALYSIS_UNREADABLE_EXPLANATION,
    isSignAnalysisUnavailable: actual.isSignAnalysisUnavailable,
    analyzeParkingSign: (...args: any[]) => analyzeParkingSign(...args),
  };
});
vi.mock('../street-parking/useParkingTimer', () => ({
  useParkingTimer: () => ({ startTimer: (...a: any[]) => { startTimer(...a); timerState.timer = { expiresAt: 1 }; }, timer: timerState.timer }),
}));

import { SignScannerView, type SignScannerAndroidBackHandle } from './SignScannerView';
import { clearRecentScans, loadRecentScans, recordScan } from '../../utils/recentScans';
import { SIGN_ANALYSIS_UNAVAILABLE_EXPLANATION, SIGN_ANALYSIS_UNREADABLE_EXPLANATION } from '../../services/geminiService';
import { setLang, t } from '../../i18n';
import en from '../../i18n/en';
import es from '../../i18n/es';

/* ── harness ─────────────────────────────────────────────────────────────── */
type R = TestRenderer.ReactTestRenderer;
function collectText(node: TestRenderer.ReactTestInstance): string {
  const out: string[] = [];
  const visit = (n: TestRenderer.ReactTestInstance) => {
    for (const c of (n.children ?? [])) {
      if (typeof c === 'string') out.push(c);
      else visit(c as TestRenderer.ReactTestInstance);
    }
  };
  visit(node);
  return out.join(' ');
}
const textOf = (r: R) => collectText(r.root);
const buttons = (r: R) => r.root.findAllByType('button');
const buttonWith = (r: R, label: string) => {
  const b = buttons(r).find(x => collectText(x).includes(label) || x.props['aria-label'] === label);
  if (!b) throw new Error(`no button "${label}" in: ${textOf(r)}`);
  return b;
};
const hasButton = (r: R, label: string) => buttons(r).some(x => collectText(x).includes(label) || x.props['aria-label'] === label);
const click = async (r: R, label: string) => { await act(async () => { buttonWith(r, label).props.onClick(); }); };
const flush = async () => { for (let i = 0; i < 4; i++) await Promise.resolve(); };

async function mount(props: React.ComponentProps<typeof SignScannerView> = {}, inputClick = vi.fn()) {
  let r: R;
  await act(async () => {
    r = TestRenderer.create(<SignScannerView {...props} />, {
      createNodeMock: (el) => (el.type === 'input' ? { click: inputClick, addEventListener() {}, removeEventListener() {} } : null),
    });
  });
  return r!;
}
async function takePhoto(r: R) {
  const file = new Blob([Uint8Array.from([137, 80, 78, 71])], { type: 'image/png' });
  await act(async () => {
    r.root.findByType('input').props.onChange({ target: { files: [file], value: 'sign.png' } });
    await flush();
  });
}
async function scanWith(r: R, result: unknown) {
  analyzeParkingSign.mockResolvedValueOnce(result);
  await click(r, t('scanner.cta'));
  await takePhoto(r);
  await act(async () => { buttonWith(r, t('scanner.read_cta')).props.onClick(); await flush(); });
}

beforeEach(() => {
  setLang('en');
  analyzeParkingSign.mockReset();
  startTimer.mockReset();
  timerState.timer = null;
  clearRecentScans();
});
afterEach(() => { vi.useRealTimers(); });

/* ── home ────────────────────────────────────────────────────────────────── */
describe('Sign Scanner home', () => {
  it('is a single-purpose screen: one title, one back control, one primary action', async () => {
    const r = await mount();
    const h1 = r.root.findAllByType('h1');
    expect(h1).toHaveLength(1);
    expect(collectText(h1[0])).toBe('Sign Scanner');
    expect(collectText(r.root.findAllByType('h2')[0])).toBe('Know before you park.');
    const backs = buttons(r).filter(b => /^Back to/.test(b.props['aria-label'] ?? ''));
    expect(backs).toHaveLength(1);
    expect(backs[0].props['aria-label']).toBe('Back to the map');
    const primaries = buttons(r).filter(b => b.props.className === 'pq-scan-cta');
    expect(primaries).toHaveLength(1);
    expect(collectText(primaries[0])).toContain('Scan a Sign');
  });

  it('carries no retired tools, placeholders, or gallery option', async () => {
    const text = textOf(await mount());
    for (const gone of ['Parking Tools', 'Hydrant', 'Am I Safe', 'Soon', 'Choose a Photo', 'Choose from photos', 'gallery']) {
      expect(text).not.toContain(gone);
    }
  });

  it('does not claim accuracy or guarantee legality anywhere on the home screen', async () => {
    const text = textOf(await mount());
    for (const banned of ['Accurate', 'guarantee', 'GUARANTEED', '100%', 'LEGAL', 'legal to park', 'LIVE']) {
      expect(text).not.toContain(banned);
    }
  });

  it('renders no Recent section at all until a real scan exists', async () => {
    const r = await mount();
    expect(textOf(r)).not.toContain('Recent scans');
    expect(textOf(r)).toContain('Get the whole pole in frame.');
  });

  it('lists real local history, compacts the hero, and drops the tip', async () => {
    recordScan({ status: 'CONDITIONAL', explanation: 'Street cleaning Tuesday 11:30 AM.' });
    const r = await mount();
    const text = textOf(r);
    expect(text).toContain('Recent scans');
    expect(text).toContain('Street cleaning Tuesday 11:30 AM.');
    expect(text).toContain('Conditional');
    expect(text).not.toContain('Get the whole pole in frame.');
    expect(r.root.findAll(n => n.props?.className === 'pq-scan-hero pq-scan-hero--compact')).toHaveLength(1);
  });

  it('back control leaves to the map', async () => {
    const onBack = vi.fn();
    const r = await mount({ onBack });
    await click(r, 'Back to the map');
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it('clears recent scans with an undo', async () => {
    recordScan({ status: 'YES', explanation: 'Two-hour parking.' });
    const r = await mount();
    await click(r, 'Clear recent scans');
    expect(textOf(r)).not.toContain('Two-hour parking.');
    expect(loadRecentScans()).toHaveLength(0);
    expect(textOf(r)).toContain('Recent scans cleared');
    await click(r, 'Undo');
    expect(textOf(r)).toContain('Two-hour parking.');
    expect(loadRecentScans()).toHaveLength(1);
  });
});

/* ── camera ──────────────────────────────────────────────────────────────── */
describe('Sign Scanner camera capture', () => {
  it('uses one camera-only file input: no gallery, no plugin', async () => {
    const r = await mount();
    const inputs = r.root.findAllByType('input');
    expect(inputs).toHaveLength(1);
    expect(inputs[0].props.type).toBe('file');
    expect(inputs[0].props.accept).toBe('image/*');
    expect(inputs[0].props.capture).toBe('environment');
    expect(inputs[0].props.multiple).toBeUndefined();
  });

  it('opens the camera directly from Scan a Sign and ignores a second tap while it is open', async () => {
    const inputClick = vi.fn();
    const r = await mount({}, inputClick);
    await act(async () => {
      buttonWith(r, 'Scan a Sign').props.onClick();
      buttonWith(r, 'Scan a Sign').props.onClick();
    });
    expect(inputClick).toHaveBeenCalledTimes(1);
  });

  it('explains calmly when the camera returns without a photo', async () => {
    vi.useFakeTimers();
    const r = await mount();
    await click(r, 'Scan a Sign');
    await act(async () => {
      windowListeners.get('focus')?.forEach(fn => fn());
      vi.advanceTimersByTime(1300);
    });
    expect(textOf(r)).toContain('No photo was taken.');
    await click(r, 'Dismiss');
    expect(textOf(r)).not.toContain('No photo was taken.');
  });

  it('does not show the no-photo hint when a photo arrives', async () => {
    vi.useFakeTimers();
    const r = await mount();
    await click(r, 'Scan a Sign');
    await takePhoto(r);
    await act(async () => {
      windowListeners.get('focus')?.forEach(fn => fn());
      vi.advanceTimersByTime(1300);
    });
    expect(textOf(r)).not.toContain('No photo was taken.');
    expect(textOf(r)).toContain('Is the whole sign readable?');
  });
});

/* ── preview & reading ───────────────────────────────────────────────────── */
describe('Sign Scanner preview and reading', () => {
  it('previews the photo and waits for an explicit read before calling the model', async () => {
    const r = await mount();
    await click(r, 'Scan a Sign');
    await takePhoto(r);
    expect(analyzeParkingSign).not.toHaveBeenCalled();
    expect(r.root.findAllByType('img')).toHaveLength(1);
    expect(r.root.findAll(n => n.props?.className === 'pq-scan-photo')).toHaveLength(1);
    expect(hasButton(r, 'Retake')).toBe(true);
    expect(buttonWith(r, 'Discard photo and go back')).toBeDefined();
  });

  it('keeps the full sign visible (object-fit: contain on the photo frame)', () => {
    const css = readFileSync(new URL('./signScanner.css', import.meta.url), 'utf8');
    expect(css).toMatch(/\.pq-scan-photo img\s*\{[^}]*object-fit:\s*contain/);
  });

  it('prevents duplicate submissions from a double tap', async () => {
    let resolveCall: (v: any) => void = () => {};
    analyzeParkingSign.mockImplementation(() => new Promise(res => { resolveCall = res; }));
    const r = await mount();
    await click(r, 'Scan a Sign');
    await takePhoto(r);
    const read = buttonWith(r, 'Read this sign');
    await act(async () => { read.props.onClick(); read.props.onClick(); });
    expect(analyzeParkingSign).toHaveBeenCalledTimes(1);
    await act(async () => { resolveCall({ status: 'YES', explanation: 'ok' }); await flush(); });
  });

  it('announces the reading state politely for screen readers', async () => {
    analyzeParkingSign.mockImplementation(() => new Promise(() => {}));
    const r = await mount();
    await click(r, 'Scan a Sign');
    await takePhoto(r);
    await act(async () => { buttonWith(r, 'Read this sign').props.onClick(); });
    const live = r.root.findAll(n => n.props?.['aria-live'] === 'polite');
    expect(live.length).toBeGreaterThan(0);
    expect(collectText(live[0])).toContain('Reading the sign');
  });

  it('cancel while reading returns home and drops the late result', async () => {
    let resolveCall: (v: any) => void = () => {};
    analyzeParkingSign.mockImplementation(() => new Promise(res => { resolveCall = res; }));
    const r = await mount();
    await click(r, 'Scan a Sign');
    await takePhoto(r);
    await act(async () => { buttonWith(r, 'Read this sign').props.onClick(); });
    await click(r, 'Cancel');
    expect(textOf(r)).toContain('Know before you park.');
    await act(async () => { resolveCall({ status: 'YES', explanation: 'Late answer.' }); await flush(); });
    expect(textOf(r)).toContain('Know before you park.');
    expect(textOf(r)).not.toContain('Late answer.');
    expect(loadRecentScans()).toHaveLength(0);
  });

  it('discarding the preview returns home without calling the model', async () => {
    const r = await mount();
    await click(r, 'Scan a Sign');
    await takePhoto(r);
    await click(r, 'Discard photo and go back');
    expect(textOf(r)).toContain('Know before you park.');
    expect(r.root.findAllByType('img')).toHaveLength(0);
    expect(analyzeParkingSign).not.toHaveBeenCalled();
  });
});

/* ── results ─────────────────────────────────────────────────────────────── */
describe('Sign Scanner results', () => {
  it('YES: hedged verdict, the interpretation, then the AI/legal boundary', async () => {
    const r = await mount();
    await scanWith(r, { status: 'YES', explanation: 'The interpreted schedule allows parking.' });
    const text = textOf(r);
    expect(text).toContain('What the sign appears to say');
    expect(text).toContain('Parking appears allowed');
    expect(text).toContain('An AI reading of your photo, not verified legal permission.');
    expect(text).toContain('It can be incomplete or wrong.');
    expect(text.indexOf('The interpreted schedule allows parking.'))
      .toBeLessThan(text.indexOf('An AI reading of your photo'));
    expect(text).not.toMatch(/you can park here|guarantee|legal to park/i);
  });

  it('NO: hedged prohibition, still marked as an interpretation', async () => {
    const r = await mount();
    await scanWith(r, { status: 'NO', explanation: 'No parking 8 AM to 6 PM.', actionableAdvice: 'Find another spot.' });
    const text = textOf(r);
    expect(text).toContain('Parking appears prohibited');
    expect(text).toContain('Find another spot.');
    expect(text).toContain('not verified legal permission');
  });

  it('CONDITIONAL without timestamps stays a conditional interpretation, not an unreadable error', async () => {
    const r = await mount();
    await scanWith(r, { status: 'CONDITIONAL', explanation: 'Depends on the day.', restrictionStartsAt: null, restrictionEndsAt: null });
    const text = textOf(r);
    expect(text).toContain('Depends on conditions');
    expect(text).toContain('Depends on the day.');
    expect(text).toContain('It may depend on the day or time, or part of the sign may be hard to read.');
    expect(text).toContain('not verified legal permission');
    expect(text).not.toContain("We couldn't read that sign.");
    expect(text).not.toContain('Unclear from this photo');
    // Primary action is unchanged; retake is offered, not forced.
    expect(collectText(buttons(r).find(b => b.props.className === 'pq-scan-cta')!)).toContain('Back to map');
    expect(hasButton(r, 'Photo unclear? Retake it')).toBe(true);
    // And it is recorded like any other interpretation.
    expect(loadRecentScans()[0].status).toBe('CONDITIONAL');
  });

  it('never states parking is definitely lawful for a conditional result', async () => {
    const r = await mount();
    await scanWith(r, { status: 'CONDITIONAL', explanation: 'Depends on the day.' });
    const text = textOf(r);
    expect(text).not.toMatch(/you can park|parking is allowed|legal to park|legally park|is legal/i);
    // The only mention of legality is the explicit negation.
    expect(text.match(/legal/gi)).toEqual(['legal']);
    expect(text).toContain('not verified legal permission');
  });

  it('shows a timing strip only when the service returned a future time', async () => {
    const soon = new Date(Date.now() + 90 * 60_000).toISOString();
    const r = await mount();
    await scanWith(r, { status: 'CONDITIONAL', explanation: 'Cleaning soon.', restrictionStartsAt: soon });
    expect(textOf(r)).toContain('Restriction starts');
    const r2 = await mount();
    await scanWith(r2, { status: 'CONDITIONAL', explanation: 'Old time.', restrictionStartsAt: '2001-01-01T10:00:00Z' });
    expect(textOf(r2)).not.toContain('Restriction starts');
  });

  it('records the scan and highlights it on the home screen afterwards', async () => {
    const r = await mount();
    await scanWith(r, { status: 'YES', explanation: 'Parking allowed after 6pm.' });
    await click(r, 'Back to Sign Scanner');
    expect(textOf(r)).toContain('Parking allowed after 6pm.');
    expect(r.root.findAll(n => n.props?.className === 'pq-scan-row pq-scan-row--new')).toHaveLength(1);
  });

  it('Back to map leaves; Scan another sign opens the camera again', async () => {
    const onBack = vi.fn();
    const inputClick = vi.fn();
    const r = await mount({ onBack }, inputClick);
    await scanWith(r, { status: 'YES', explanation: 'ok' });
    inputClick.mockClear();
    await act(async () => { windowListeners.get('focus')?.forEach(fn => fn()); });
    await click(r, 'Scan another sign');
    expect(inputClick).toHaveBeenCalledTimes(1);
    await click(r, 'Back to map');
    expect(onBack).toHaveBeenCalledTimes(1);
  });
});

/* ── reminders (timing unchanged; withheld for NO) ───────────────────────── */
describe('Sign Scanner reminders', () => {
  it('keeps the existing timing: minutes until restrictionStartsAt', async () => {
    const startsAt = new Date(Date.now() + 47 * 60_000 + 30_000).toISOString();
    const r = await mount();
    await scanWith(r, { status: 'YES', explanation: 'ok', restrictionStartsAt: startsAt, actionableAdvice: 'Move by then.' });
    const remind = buttons(r).find(b => b.props.className === 'pq-scan-remind')!;
    expect(collectText(remind)).toMatch(/^Remind me at /);
    await act(async () => { remind.props.onClick(); });
    expect(startTimer).toHaveBeenCalledTimes(1);
    expect(startTimer).toHaveBeenCalledWith(48, 'parking sign');
  });

  it('keeps the existing 60-minute fallback when no start time came back', async () => {
    const r = await mount();
    await scanWith(r, { status: 'CONDITIONAL', explanation: 'ok', actionableAdvice: 'Check again later.' });
    await click(r, 'Remind me in 1 hour');
    expect(startTimer).toHaveBeenCalledWith(60, 'parking sign');
  });

  it('does not offer a reminder when parking appears prohibited', async () => {
    const r = await mount();
    await scanWith(r, {
      status: 'NO', explanation: 'No parking.', actionableAdvice: 'Move now.',
      restrictionStartsAt: new Date(Date.now() + 30 * 60_000).toISOString(),
    });
    expect(textOf(r)).toContain('Move now.');
    expect(buttons(r).some(b => b.props.className === 'pq-scan-remind')).toBe(false);
  });

  it('does not offer a reminder without actionable advice (unchanged)', async () => {
    const r = await mount();
    await scanWith(r, { status: 'YES', explanation: 'ok' });
    expect(buttons(r).some(b => b.props.className === 'pq-scan-remind')).toBe(false);
  });
});

/* ── errors ──────────────────────────────────────────────────────────────── */
describe('Sign Scanner errors', () => {
  it('unreadable: leads with Retake, offers the same photo again, no AI disclaimer, nothing recorded', async () => {
    const r = await mount();
    await scanWith(r, { status: 'ERROR', explanation: SIGN_ANALYSIS_UNREADABLE_EXPLANATION });
    const text = textOf(r);
    expect(text).toContain("We couldn't read that sign.");
    expect(text.split("We couldn't read that sign.").length - 1).toBe(1);
    expect(text).not.toContain('An AI reading of your photo');
    expect(collectText(buttons(r).find(b => b.props.className === 'pq-scan-cta')!)).toContain('Retake photo');
    expect(hasButton(r, 'Try this photo again')).toBe(true);
    expect(loadRecentScans()).toHaveLength(0);
  });

  it('unavailable: leads with Try again on the same photo', async () => {
    const r = await mount();
    await scanWith(r, { status: 'ERROR', explanation: SIGN_ANALYSIS_UNAVAILABLE_EXPLANATION });
    expect(textOf(r)).toContain('Sign reading is unavailable right now.');
    expect(collectText(buttons(r).find(b => b.props.className === 'pq-scan-cta')!)).toContain('Try again');
    analyzeParkingSign.mockResolvedValueOnce({ status: 'YES', explanation: 'Now it worked.' });
    await act(async () => { buttonWith(r, 'Try again').props.onClick(); await flush(); });
    expect(analyzeParkingSign).toHaveBeenCalledTimes(2);
    expect(textOf(r)).toContain('Now it worked.');
  });

  it('a thrown call is treated as unavailable, not as a bad photo', async () => {
    analyzeParkingSign.mockRejectedValueOnce(new Error('network'));
    const r = await mount();
    await click(r, 'Scan a Sign');
    await takePhoto(r);
    await act(async () => { buttonWith(r, 'Read this sign').props.onClick(); await flush(); });
    expect(textOf(r)).toContain('Sign reading is unavailable right now.');
  });

  it('the dev preview mock mirrors the real error texts exactly', async () => {
    const mock = readFileSync(new URL('../../docs/previews/sign-scanner/mockGeminiService.ts', import.meta.url), 'utf8');
    expect(mock).toContain(SIGN_ANALYSIS_UNAVAILABLE_EXPLANATION.replace('\n', '\\n'));
    expect(mock).toContain(SIGN_ANALYSIS_UNREADABLE_EXPLANATION.replace('\n', '\\n'));
  });

  it('never shows the service’s English error text in the UI', async () => {
    const r = await mount();
    await scanWith(r, { status: 'ERROR', explanation: SIGN_ANALYSIS_UNAVAILABLE_EXPLANATION });
    expect(textOf(r)).not.toContain('Assistant temporarily unavailable');
  });
});

/* ── Android Back ────────────────────────────────────────────────────────── */
describe('Sign Scanner Android Back', () => {
  it('returns nested scan states to the scanner home without leaving', async () => {
    const onBack = vi.fn();
    const backRef = { current: null as SignScannerAndroidBackHandle | null };
    const r = await mount({ onBack, androidBackRef: backRef });
    await scanWith(r, { status: 'YES', explanation: 'ok' });
    expect(textOf(r)).toContain('Parking appears allowed');
    await act(async () => { expect(backRef.current!.handleAndroidBack()).toBe('handled'); });
    expect(onBack).not.toHaveBeenCalled();
    expect(textOf(r)).toContain('Know before you park.');
  });

  it('from the preview, discards the photo and stays in the scanner', async () => {
    const onBack = vi.fn();
    const backRef = { current: null as SignScannerAndroidBackHandle | null };
    const r = await mount({ onBack, androidBackRef: backRef });
    await click(r, 'Scan a Sign');
    await takePhoto(r);
    await act(async () => { expect(backRef.current!.handleAndroidBack()).toBe('handled'); });
    expect(r.root.findAllByType('img')).toHaveLength(0);
    expect(onBack).not.toHaveBeenCalled();
  });

  it('leaves to the map from the scanner home', async () => {
    const onBack = vi.fn();
    const backRef = { current: null as SignScannerAndroidBackHandle | null };
    await mount({ onBack, androidBackRef: backRef });
    expect(backRef.current!.handleAndroidBack()).toBe('leave');
    expect(onBack).toHaveBeenCalledTimes(1);
  });
});

/* ── Spanish ─────────────────────────────────────────────────────────────── */
describe('Sign Scanner in Spanish', () => {
  const englishOnly = Object.keys(en)
    .filter(k => k.startsWith('scanner.') && (en as Record<string, string>)[k] !== (es as Record<string, string>)[k])
    .map(k => (en as Record<string, string>)[k].replace(/\{\w+\}.*$/, '').trim())
    .filter(v => v.length > 3);

  const expectNoEnglish = (text: string) => {
    for (const v of englishOnly) expect(text, v).not.toContain(v);
  };

  it('renders home, result and error screens with no English UI copy', async () => {
    setLang('es');
    recordScan({ status: 'YES', explanation: 'Se permite parquear.' });
    const r = await mount();
    expect(textOf(r)).toContain('Infórmate antes de parquear.');
    expect(textOf(r)).toContain('Escaneos recientes');
    expectNoEnglish(textOf(r));

    await scanWith(r, { status: 'CONDITIONAL', explanation: 'Depende del día.', actionableAdvice: 'Revisa más tarde.' });
    expect(textOf(r)).toContain('Depende de las condiciones');
    expect(textOf(r)).toContain('Recordármelo en 1 hora');
    expectNoEnglish(textOf(r));

    const r2 = await mount();
    await scanWith(r2, { status: 'ERROR', explanation: SIGN_ANALYSIS_UNAVAILABLE_EXPLANATION });
    expect(textOf(r2)).toContain('La lectura de señales no está disponible en este momento.');
    expectNoEnglish(textOf(r2));
  });
});
