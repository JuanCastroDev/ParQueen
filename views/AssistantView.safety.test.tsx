import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const analyzeParkingSign = vi.fn();

vi.hoisted(() => {
  const store = new Map<string, string>();
  (globalThis as any).localStorage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => store.set(key, value),
    removeItem: (key: string) => store.delete(key),
  };
  (globalThis as any).window = { addEventListener: () => {}, removeEventListener: () => {} };
});

vi.mock('../services/geminiService', () => ({
  analyzeParkingSign: (...args: any[]) => analyzeParkingSign(...args),
}));
vi.mock('../hooks/useFocusOnMount', () => ({ useFocusOnMount: () => {} }));
vi.mock('./street-parking/useParkingTimer', () => ({
  useParkingTimer: () => ({ startTimer: vi.fn(), timer: null }),
}));

import { AssistantView } from './AssistantView';

/**
 * Collects every string child in a subtree. An earlier version only looked at
 * nodes whose FIRST child was a string, which silently skipped icon-then-label
 * buttons such as `<ScanLine /> Analyze Sign`.
 */
function collectText(node: TestRenderer.ReactTestInstance): string {
  const out: string[] = [];
  const visit = (n: TestRenderer.ReactTestInstance) => {
    for (const child of (n.children ?? [])) {
      if (typeof child === 'string') out.push(child);
      else visit(child as TestRenderer.ReactTestInstance);
    }
  };
  visit(node);
  return out.join(' ');
}

function textOf(renderer: TestRenderer.ReactTestRenderer): string {
  return collectText(renderer.root);
}

function nodeText(node: TestRenderer.ReactTestInstance): string {
  try { return collectText(node); } catch { return ''; }
}

function buttonWith(renderer: TestRenderer.ReactTestRenderer, label: string) {
  const found = renderer.root.findAllByType('button').find(b => nodeText(b).includes(label));
  if (!found) throw new Error(`no button containing "${label}"`);
  return found;
}

/** Drives hub -> scan -> photo chosen -> analyze, the real production path. */
async function runScan(renderer: TestRenderer.ReactTestRenderer) {
  await act(async () => { buttonWith(renderer, 'Scan a Parking Sign').props.onClick(); });
  const input = renderer.root.findAllByType('input')[0];
  const file = new Blob([Uint8Array.from([137, 80, 78, 71])], { type: 'image/png' });
  await act(async () => {
    input.props.onChange({ target: { files: [file], value: 'sign.png' } });
    await Promise.resolve();
    await Promise.resolve();
  });
  await act(async () => {
    buttonWith(renderer, 'Analyze Sign').props.onClick();
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('AssistantView sign-result safety copy', () => {
  beforeEach(() => {
    analyzeParkingSign.mockReset();
    analyzeParkingSign.mockResolvedValue({ status: 'YES', explanation: 'The interpreted schedule allows parking.' });
    (globalThis as any).localStorage.removeItem('parqueen_recent_scans');
  });

  it('places an explicit AI limitation beside a successful sign interpretation', async () => {
    let renderer: TestRenderer.ReactTestRenderer;
    await act(async () => { renderer = TestRenderer.create(<AssistantView />); });
    await runScan(renderer!);

    const text = textOf(renderer!);
    expect(text).toContain('AI interpretation may be incomplete or incorrect. Verify posted signs.');
    expect(text.indexOf('The interpreted schedule allows parking.'))
      .toBeLessThan(text.indexOf('AI interpretation may be incomplete or incorrect. Verify posted signs.'));
  });

  it('does not attach the parking-permitted disclaimer to an unreadable-sign error', async () => {
    // An error is not an interpretation, so the "verify posted signs" line would
    // imply we read something. The friendly error copy stands alone instead.
    analyzeParkingSign.mockResolvedValue({ status: 'ERROR', explanation: "Couldn't read this sign\nTry another photo." });
    let renderer: TestRenderer.ReactTestRenderer;
    await act(async () => { renderer = TestRenderer.create(<AssistantView />); });
    await runScan(renderer!);

    const text = textOf(renderer!);
    expect(text).toContain("We couldn't read that sign.");
    expect(text).not.toContain('AI interpretation may be incomplete or incorrect.');
    expect(text).toContain('Try again');
    expect(text).toContain('Choose another photo');
  });

  it('never states parking is definitely lawful for a conditional result', async () => {
    analyzeParkingSign.mockResolvedValue({ status: 'CONDITIONAL', explanation: 'Depends on the day.' });
    let renderer: TestRenderer.ReactTestRenderer;
    await act(async () => { renderer = TestRenderer.create(<AssistantView />); });
    await runScan(renderer!);

    const text = textOf(renderer!);
    expect(text).toContain('Conditional.');
    expect(text).toContain('AI interpretation may be incomplete or incorrect. Verify posted signs.');
  });
});
