import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { createRequire } from 'node:module';
import path from 'node:path';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing';

const bridge = vi.hoisted(() => ({
  auth: null as null | { uid: string; token: Record<string, unknown> },
  handler: null as null | ((request: { data: unknown; auth?: unknown }) => Promise<unknown>),
  segments: [] as Array<Record<string, unknown> & { id: string }>,
}));

vi.hoisted(() => {
  const store = new Map<string, string>();
  (globalThis as { localStorage: Storage }).localStorage = {
    getItem: (key: string) => (store.has(key) ? store.get(key)! : null),
    setItem: (key: string, value: string) => { store.set(key, String(value)); },
    removeItem: (key: string) => { store.delete(key); },
    clear: () => { store.clear(); },
    key: () => null,
    length: 0,
  } as Storage;
  (globalThis as { window: Window }).window = {
    location: { search: '' },
    addEventListener: () => {},
    removeEventListener: () => {},
  } as unknown as Window;
  (globalThis as { confirm: (message: string) => boolean }).confirm = () => false;
});

vi.mock('./firebase', () => ({ db: {} }));
vi.mock('firebase/app', () => ({ getApp: () => ({}) }));
vi.mock('firebase/functions', () => ({
  getFunctions: () => ({}),
  httpsCallable: () => async (data: { view?: string; params?: Record<string, unknown> }) => {
    if (!bridge.handler) throw new Error('admin handler is not ready');
    const request: { data: unknown; auth?: unknown } = { data };
    if (bridge.auth) request.auth = bridge.auth;
    try {
      return { data: await bridge.handler(request) };
    } catch (err) {
      const failure = err as { message?: string };
      throw new Error(failure.message || 'Read failed.');
    }
  },
}));
vi.mock('firebase/firestore', () => ({
  collection: () => ({ __kind: 'collection' }),
  query: (base: unknown) => base,
  where: () => ({}),
  orderBy: () => ({}),
  getDocs: async () => ({
    docs: bridge.segments.map(segment => ({
      id: segment.id,
      data: () => segment,
    })),
  }),
}));

import { StreetSegmentsPage } from './views/admin/StreetSegmentsPage';

const require = createRequire(path.join(process.cwd(), 'functions/package.json'));
const {
  buildStreetRulesClosedCandidate,
  loadProductionRules,
  streetRulesReadDiff,
} = require('./curbIntelligence/streetRulesCandidate.js');

const isolated = process.env.PARQUEEN_ACCEPTANCE_EMULATOR === '1'
  && process.env.FIRESTORE_EMULATOR_HOST === '127.0.0.1:8282'
  && process.env.FIREBASE_AUTH_EMULATOR_HOST === '127.0.0.1:9199'
  && process.env.GCLOUD_PROJECT === 'demo-parkqueen-replay-test';

const PROJECT_ID = 'demo-parkqueen-replay-test';
const PRIVATE_BLOCK_FACE = '1522611401';
const generation = 'c'.repeat(32);
const otherGeneration = 'd'.repeat(32);

function stamp(generationId: string) {
  return {
    scheme: 1,
    generationId,
    deadlineAtMs: 2_000_000_000_000,
    committedAt: 1000,
    promotedAt: 1500,
  };
}

function textOf(renderer: TestRenderer.ReactTestRenderer): string {
  return renderer.root.findAll(node => node.children?.some(child => typeof child === 'string'))
    .flatMap(node => node.children.filter((child): child is string => typeof child === 'string'))
    .join(' ');
}

function expandButton(renderer: TestRenderer.ReactTestRenderer, street: string) {
  const name = renderer.root.findAll(node => node.type === 'p' && node.children?.[0] === street)[0];
  if (!name?.parent?.parent) throw new Error(`missing row for ${street}`);
  const expand = name.parent.parent.findAll(node => node.type === 'button')
    .find(button => button.props.title == null && button.props.type == null);
  if (!expand) throw new Error(`missing expand control for ${street}`);
  return expand;
}

function buttonByText(renderer: TestRenderer.ReactTestRenderer, label: string) {
  const matches = renderer.root.findAll(node => (
    node.type === 'button' && node.children?.some(child => child === label)
  ));
  if (matches.length !== 1) throw new Error(`expected one "${label}" button, saw ${matches.length}`);
  return matches[0];
}

async function click(node: { props: { onClick?: () => void } }) {
  await act(async () => {
    node.props.onClick?.();
  });
}

async function waitFor(
  renderer: TestRenderer.ReactTestRenderer,
  predicate: (text: string) => boolean,
  label: string,
) {
  let text = '';
  for (let attempt = 0; attempt < 100; attempt += 1) {
    text = textOf(renderer);
    if (predicate(text) && !text.includes('Loading…') && !text.includes('Loading more…') && !text.includes('Loading segments…')) {
      return text;
    }
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 100));
    });
  }
  throw new Error(`${label}\n${text.slice(0, 1500)}`);
}

describe.skipIf(!isolated)('street rules migration acceptance on an isolated emulator', () => {
  let db: any;
  let rulesEnv: RulesTestEnvironment;
  const productionRules = loadProductionRules(process.cwd());
  const candidateRules = buildStreetRulesClosedCandidate(productionRules);

  beforeAll(async () => {
    const diff = streetRulesReadDiff(productionRules, candidateRules);
    if (diff.length !== 2) throw new Error(`expected two candidate lines, saw ${diff.length}`);
    bridge.handler = require('./index.js')._adminReadViewHandler;
    const { getFirestore } = require('firebase-admin/firestore');
    db = getFirestore();
    const existing = await db.collection('streetSegments').get();
    for (const segment of existing.docs) await db.recursiveDelete(segment.ref);
    const authority = stamp(generation);
    await db.doc('streetSegments/curb-filter').set({
      id: 'curb-filter',
      streetName: 'Filter Street',
      status: 'active',
      source: 'admin',
      borough: 'MN',
      writeAuthority: authority,
    });
    await db.doc('streetSegments/curb-filter/streetRules/rule-active').set({
      type: 'streetCleaning',
      supersededAt: null,
      writeAuthority: authority,
      schedules: [{ side: 'KeptActive', days: ['Mon'], startTime: '08:00', endTime: '09:30' }],
      officialBlockFaceId: PRIVATE_BLOCK_FACE,
      provenance: { importedBy: 'private-job' },
    });
    await db.doc('streetSegments/curb-filter/streetRules/rule-superseded').set({
      type: 'streetCleaning',
      supersededAt: new Date(),
      writeAuthority: authority,
      schedules: [{ side: 'LeakedSuperseded', days: ['Mon'], startTime: '01:00', endTime: '02:00' }],
    });
    await db.doc('streetSegments/curb-filter/streetRules/rule-mismatched').set({
      type: 'streetCleaning',
      supersededAt: null,
      writeAuthority: stamp(otherGeneration),
      schedules: [{ side: 'LeakedMismatch', days: ['Tue'], startTime: '03:00', endTime: '04:00' }],
    });
    await db.doc('streetSegments/curb-filter/streetRules/rule-legacy').set({
      type: 'streetCleaning',
      supersededAt: null,
      schedules: [{ side: 'LeakedLegacy', days: ['Wed'], startTime: '05:00', endTime: '06:00' }],
    });
    await seedPage('curb-pages', 'Page Street', 'T');
    await seedPage('curb-retry', 'Retry Street', 'R');
    await db.doc('suspensions/holiday-1').set({ date: '2026-12-25', label: 'Holiday', type: 'holiday' });
    bridge.segments = [
      { id: 'curb-filter', streetName: 'Filter Street', status: 'active', source: 'admin', borough: 'MN' },
      { id: 'curb-pages', streetName: 'Page Street', status: 'active', source: 'admin', borough: 'MN' },
      { id: 'curb-retry', streetName: 'Retry Street', status: 'active', source: 'admin', borough: 'MN' },
    ];
    rulesEnv = await loadRules(productionRules);
  }, 120000);

  async function seedPage(segmentId: string, streetName: string, marker: string) {
    const authority = stamp(generation);
    await db.doc(`streetSegments/${segmentId}`).set({
      id: segmentId,
      streetName,
      status: 'active',
      source: 'admin',
      borough: 'MN',
      writeAuthority: authority,
    });
    const batch = db.batch();
    for (let index = 0; index <= 100; index += 1) {
      const id = `rule-${String(index).padStart(4, '0')}`;
      batch.set(db.doc(`streetSegments/${segmentId}/streetRules/${id}`), {
        type: 'streetCleaning',
        supersededAt: null,
        writeAuthority: authority,
        schedules: [{ side: 'West', days: ['Mon'], startTime: '08:00', endTime: `${marker}${index}` }],
      });
    }
    await batch.commit();
  }

  async function loadRules(rules: string) {
    return initializeTestEnvironment({
      projectId: PROJECT_ID,
      firestore: { rules, host: '127.0.0.1', port: 8282 },
    });
  }

  async function clientReads(schedule: 'allow' | 'deny') {
    const { getDoc, doc } = await vi.importActual<typeof import('firebase/firestore')>('firebase/firestore');
    const anon = rulesEnv.unauthenticatedContext().firestore();
    await assertSucceeds(getDoc(doc(anon, 'streetSegments', 'curb-filter')));
    await assertSucceeds(getDoc(doc(anon, 'suspensions', 'holiday-1')));
    const scheduleRead = getDoc(doc(anon, 'streetSegments', 'curb-filter', 'streetRules', 'rule-active'));
    if (schedule === 'allow') await assertSucceeds(scheduleRead);
    else await assertFails(scheduleRead);
  }

  async function renderPage() {
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(<StreetSegmentsPage />);
    });
    await waitFor(renderer, text => text.includes('Filter Street'), 'segment list did not render');
    return renderer;
  }

  async function signIn(uid: string, claims?: Record<string, unknown>) {
    const { getAuth } = require('firebase-admin/auth');
    const auth = getAuth();
    await auth.createUser({ uid }).catch(() => {});
    await auth.setCustomUserClaims(uid, claims ?? {});
    const custom = await auth.createCustomToken(uid);
    const response = await fetch(
      'http://127.0.0.1:9199/identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=fake-key',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: custom, returnSecureToken: true }),
      },
    );
    const body = await response.json() as { idToken?: string };
    if (!body.idToken) throw new Error(JSON.stringify(body));
    const token = JSON.parse(Buffer.from(body.idToken.split('.')[1], 'base64url').toString('utf8')) as Record<string, unknown>;
    token.uid = token.sub || token.user_id;
    return { uid, token };
  }

  it('keeps admin schedules available across the rules closure and restores the old client read on rollback', async () => {
    await clientReads('allow');

    bridge.auth = null;
    const screen = await renderPage();
    await click(expandButton(screen, 'Filter Street'));
    let text = await waitFor(screen, value => value.includes('Sign in first.'), 'signed-out admin read');
    expect(text).not.toContain('KeptActive');
    expect(text).not.toContain(PRIVATE_BLOCK_FACE);

    bridge.auth = await signIn('acceptance-user', {});
    await click(expandButton(screen, 'Filter Street'));
    await click(expandButton(screen, 'Filter Street'));
    text = await waitFor(screen, value => value.includes('Admin only.'), 'ordinary user admin read');
    expect(text).not.toContain('KeptActive');

    bridge.auth = await signIn('acceptance-admin', { role: 'admin' });
    await click(expandButton(screen, 'Filter Street'));
    await click(expandButton(screen, 'Filter Street'));
    text = await waitFor(screen, value => value.includes('KeptActive'), 'current admin schedule');
    expect(text).not.toContain('LeakedSuperseded');
    expect(text).not.toContain('LeakedMismatch');
    expect(text).not.toContain('LeakedLegacy');
    expect(text).not.toContain(PRIVATE_BLOCK_FACE);
    expect(text).not.toContain('private-job');

    await click(expandButton(screen, 'Page Street'));
    text = await waitFor(screen, value => value.includes('– T0') && value.includes('Load more cleaning rules'), 'first schedule page');
    expect(text).not.toContain('– T100');
    await click(buttonByText(screen, 'Load more cleaning rules'));
    text = await waitFor(screen, value => value.includes('– T100'), 'later schedule page');
    expect(text).toContain('– T0');

    await click(expandButton(screen, 'Page Street'));
    await click(expandButton(screen, 'Retry Street'));
    text = await waitFor(screen, value => value.includes('– R0') && value.includes('Load more cleaning rules'), 'retry first page');
    expect(text).not.toContain('– R100');
    await db.doc('streetSegments/curb-retry/streetRules/rule-0099').delete();
    await click(buttonByText(screen, 'Load more cleaning rules'));
    text = await waitFor(screen, value => value.includes('The schedule page cursor is no longer valid. Reload the list.'), 'stale cursor');
    expect(text).toContain('– R0');
    expect(text).not.toContain('– R100');
    await click(expandButton(screen, 'Retry Street'));
    await click(expandButton(screen, 'Retry Street'));
    text = await waitFor(
      screen,
      value => value.includes('– R0') && !value.includes('no longer valid'),
      'retry after the cursor error',
    );

    rulesEnv = await loadRules(candidateRules);
    await clientReads('deny');
    await click(buttonByText(screen, 'Health'));
    text = await waitFor(screen, value => value.includes('Active Rules') && value.includes('204'), 'health view under closed reads');
    expect(text).not.toContain('Read failed.');
    expect(text).not.toContain(PRIVATE_BLOCK_FACE);

    rulesEnv = await loadRules(productionRules);
    await clientReads('allow');
  }, 180000);
});
