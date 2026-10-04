import React, { useState } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BottomSheet } from './BottomSheet';
import { FinishHandoffChip } from './FinishHandoffChip';

vi.hoisted(() => {
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
      clear: () => values.clear(),
    },
  });
});

vi.mock('../../firebase', () => ({ db: { __db: true } }));

const { getDocs, onSnapshot, runTransaction, setDoc, updateDoc, deleteDoc, listeners } = vi.hoisted(() => {
  const listeners = new Map<string, Set<(snap: { docs: any[] }) => void>>();
  const bucket = (name: string) => {
    let set = listeners.get(name);
    if (!set) {
      set = new Set();
      listeners.set(name, set);
    }
    return set;
  };
  return {
    listeners,
    getDocs: vi.fn(async () => ({ empty: true, docs: [] })),
    onSnapshot: vi.fn((q: { __collection: string }, onNext: (snap: { docs: any[] }) => void) => {
      const set = bucket(q.__collection);
      set.add(onNext);
      return () => set.delete(onNext);
    }),
    runTransaction: vi.fn(),
    setDoc: vi.fn(async (ref: { path: string }, data: Record<string, any>) => {
      documents.set(ref.path, data);
    }),
    updateDoc: vi.fn(async () => {}),
    deleteDoc: vi.fn(async () => {}),
  };
});

vi.mock('firebase/firestore', () => ({
  addDoc: vi.fn(async () => ({ id: 'notification' })),
  collection: vi.fn((_db: unknown, name: string) => ({ __collection: name })),
  deleteDoc,
  doc: vi.fn((_db: unknown, ...parts: string[]) => ({ path: parts.join('/') })),
  getDoc: vi.fn(async (ref: { path: string }) => snapshotFor(ref)),
  getDocs,
  increment: vi.fn((n: number) => ({ __increment: n })),
  limit: vi.fn(),
  onSnapshot,
  orderBy: vi.fn(),
  query: vi.fn((source: { __collection: string }, ...constraints: unknown[]) => ({
    __collection: source.__collection,
    __constraints: constraints,
  })),
  runTransaction,
  setDoc,
  Timestamp: {
    fromMillis: (ms: number) => ({ toMillis: () => ms }),
    now: () => ({ toMillis: () => 1_700_000_000_000 }),
  },
  updateDoc,
  where: vi.fn((field: string, op: string, value: unknown) => ({ field, op, value })),
}));

vi.mock('../../utils/errorReporting', () => ({ reportCriticalActionFailure: vi.fn() }));

import { useInterestFlow } from './useInterestFlow';
import { selectUnfinishedHandoff } from './unfinishedHandoff';

const user = { id: 'driver-1', username: 'Driver', crowns: 0 };
const documents = new Map<string, Record<string, any>>();

function snapshotFor(ref: { path: string }) {
  const data = documents.get(ref.path);
  return { exists: () => data !== undefined, data: () => data };
}

function snapDoc(id: string, data: Record<string, any>) {
  return { id, data: () => data };
}

const arrivedSpot = {
  lat: 40.7,
  lng: -73.9,
  address: '1 Main St',
  finderId: 'finder-1',
  finderName: 'Finder',
  geohash: 'dr5reg',
  status: 'occupied',
  claimState: 'arrived_pending_outcome',
  interestedUserId: user.id,
  arrivedAt: { toMillis: () => 5_000 },
};

function arrivalFields(data: Record<string, any> | undefined) {
  return {
    status: data?.status,
    claimState: data?.claimState,
    interestedUserId: data?.interestedUserId,
    arrivedAtMs: data?.arrivedAt?.toMillis?.() ?? null,
  };
}

async function emit(collectionName: string, docs: Array<{ id: string; data: () => any }>) {
  await act(async () => {
    listeners.get(collectionName)?.forEach((fn) => fn({ docs }));
  });
}

async function emitResume(spotId: string, data: Record<string, any>, feedback: Array<{ id: string; data: () => any }> = []) {
  documents.set(`spots/${spotId}`, data);
  await emit('spots', [snapDoc(spotId, data)]);
  await emit('spotFeedback', feedback);
}

let renderer: TestRenderer.ReactTestRenderer | undefined;

function mount(initialSpot: any = null) {
  let flow!: ReturnType<typeof useInterestFlow>;
  act(() => {
    renderer = TestRenderer.create(<Harness initialSpot={initialSpot} onReady={(next) => { flow = next; }} />);
  });
  return { getFlow: () => flow };
}

function Harness({
  initialSpot,
  onReady,
}: {
  initialSpot: any;
  onReady: (flow: ReturnType<typeof useInterestFlow>) => void;
}) {
  const [selectedItem, setSelectedItem] = useState<any>(initialSpot);
  const flow = useInterestFlow({
    selectedItem,
    setSelectedItem,
    user,
    freeSpots: initialSpot ? [initialSpot] : [],
    userLocation: null,
    mapRef: { current: null },
    activeRouteDestinationRef: { current: null },
  });
  onReady(flow);
  return (
    <>
      {flow.unfinishedHandoff && flow.handoffStep === null && (
        <FinishHandoffChip onResume={flow.resumeUnfinishedHandoff} />
      )}
      <BottomSheet
        isOpen={flow.handoffStep !== null}
        ariaLabel="Handoff"
        onClose={() => { flow.handleSkipDeparture(); }}
      >
        <div data-testid="handoff-step">{flow.handoffStep}</div>
      </BottomSheet>
    </>
  );
}

function chipCount() {
  return renderer?.root.findAll((node) => node.props['data-testid'] === 'finish-handoff-chip').length ?? 0;
}

function clickChip() {
  const chip = renderer!.root.findByProps({ 'data-testid': 'finish-handoff-chip' });
  const button = chip.findByType('button');
  act(() => { button.props.onClick(); });
}

async function dismissSheet() {
  const backdrop = renderer!.root.findAll((node) => (
    typeof node.props.className === 'string' && node.props.className.includes('pq-bottom-sheet-backdrop')
  ))[0];
  await act(async () => {
    backdrop.props.onClick();
    await new Promise((resolve) => setTimeout(resolve, 320));
  });
}

describe('useInterestFlow — resumable finish-your-handoff', () => {
  beforeEach(() => {
    listeners.clear();
    documents.clear();
    getDocs.mockClear();
    setDoc.mockClear();
    updateDoc.mockClear();
    deleteDoc.mockClear();
    runTransaction.mockReset();
    runTransaction.mockImplementation(async (_db: unknown, callback: (tx: any) => Promise<any>) => {
      const queued: Array<{ op: 'set' | 'update' | 'delete'; path: string; data?: Record<string, any> }> = [];
      const result = await callback({
        get: async (ref: { path: string }) => snapshotFor(ref),
        set: (ref: { path: string }, data: Record<string, any>) => queued.push({ op: 'set', path: ref.path, data }),
        update: (ref: { path: string }, data: Record<string, any>) => queued.push({ op: 'update', path: ref.path, data }),
        delete: (ref: { path: string }) => queued.push({ op: 'delete', path: ref.path }),
      });
      for (const write of queued) {
        if (write.op === 'delete') documents.delete(write.path);
        else if (write.op === 'update') documents.set(write.path, { ...(documents.get(write.path) ?? {}), ...write.data });
        else documents.set(write.path, write.data!);
      }
      return result;
    });
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      cb(0);
      return 1;
    });
    vi.stubGlobal('window', {
      innerHeight: 800,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    });
  });

  afterEach(() => {
    act(() => { renderer?.unmount(); });
    renderer = undefined;
    vi.unstubAllGlobals();
  });

  it('seeded arrived_pending_outcome exposes the finish-your-handoff chip and opens outcome', async () => {
    const { getFlow } = mount();
    expect(chipCount()).toBe(0);

    await emitResume('spot-1', arrivedSpot);

    expect(chipCount()).toBe(1);
    expect(JSON.stringify(renderer!.toJSON())).toContain('Finish your handoff');
    const chip = renderer!.root.findByProps({ 'data-testid': 'finish-handoff-chip' });
    expect(chip.props.role).toBeUndefined();
    expect(renderer!.root.findAllByProps({ role: 'dialog' })).toHaveLength(0);

    clickChip();

    expect(getFlow().handoffStep).toBe('outcome');
    expect(getFlow().unfinishedHandoff).toMatchObject({
      id: 'spot-1',
      finderId: 'finder-1',
      address: '1 Main St',
    });
    expect(renderer!.root.findAllByProps({ role: 'dialog' })).toHaveLength(1);
  });

  it('sheet dismiss does not clear server fields and the chip stays', async () => {
    documents.set('spots/spot-1', { ...arrivedSpot });
    const { getFlow } = mount();
    await emitResume('spot-1', arrivedSpot);
    clickChip();
    await act(async () => { await getFlow().handleHandoffOutcome('failed'); });
    expect(getFlow().handoffStep).toBe('failure_reason');
    const before = arrivalFields(documents.get('spots/spot-1'));
    const writesBefore = runTransaction.mock.calls.length;

    await dismissSheet();

    expect(getFlow().handoffStep).toBeNull();
    expect(chipCount()).toBe(1);
    expect(arrivalFields(documents.get('spots/spot-1'))).toEqual(before);
    expect(documents.has('spotFeedback/spot-1_driver-1')).toBe(false);
    expect(runTransaction.mock.calls.length).toBe(writesBefore);
    expect(setDoc).not.toHaveBeenCalled();
    expect(updateDoc).not.toHaveBeenCalled();
    expect(deleteDoc).not.toHaveBeenCalled();

    clickChip();
    expect(getFlow().handoffStep).toBe('outcome');
  });

  it('a one-sided participant_success leaves Finish-your-handoff recoverable', async () => {
    const { getFlow } = mount();
    await emitResume('spot-1', { ...arrivedSpot });
    clickChip();

    await act(async () => { await getFlow().handleHandoffOutcome('success'); });

    expect(getFlow().handoffStep).toBe('waiting');
    expect(documents.get('spotFeedback/spot-1_driver-1')).toMatchObject({
      outcome: 'participant_success',
      role: 'claimer',
      userId: user.id,
      failureReason: null,
    });
    expect(documents.has('spotFeedback/spot-1_driver-1_finder')).toBe(false);
    expect(documents.get('spots/spot-1')?.claimState).toBe('arrived_pending_outcome');

    await dismissSheet();
    expect(getFlow().handoffStep).toBeNull();
    expect(chipCount()).toBe(1);
    expect(JSON.stringify(renderer!.toJSON())).toContain('Finish your handoff');

    await emit('spots', [snapDoc('spot-1', documents.get('spots/spot-1')!)]);
    await emit('spotFeedback', [
      snapDoc('spot-1_driver-1', documents.get('spotFeedback/spot-1_driver-1')!),
      snapDoc('spot-1_driver-1_finder', {
        spotId: 'spot-1',
        userId: user.id,
        finderId: 'finder-1',
        outcome: 'participant_success',
        role: 'finder',
      }),
    ]);
    expect(chipCount()).toBe(1);
    expect(getFlow().unfinishedHandoff?.id).toBe('spot-1');
  });

  it('completed_success and unconfirmed drop the chip; failed still ends the handoff', async () => {
    const { getFlow } = mount();
    await emitResume('spot-1', { ...arrivedSpot });
    expect(chipCount()).toBe(1);

    await emit('spots', [snapDoc('spot-1', { ...arrivedSpot, claimState: 'completed_success' })]);
    await emit('spotFeedback', [snapDoc('spot-1_driver-1', {
      spotId: 'spot-1', userId: user.id, outcome: 'participant_success', role: 'claimer',
    })]);
    expect(chipCount()).toBe(0);
    expect(getFlow().unfinishedHandoff).toBeNull();

    await emit('spots', [snapDoc('spot-1', { ...arrivedSpot, claimState: 'unconfirmed' })]);
    await emit('spotFeedback', []);
    expect(chipCount()).toBe(0);

    await emit('spots', [snapDoc('spot-1', arrivedSpot)]);
    await emit('spotFeedback', [snapDoc('spot-1_driver-1', {
      spotId: 'spot-1', userId: user.id, outcome: 'failed', failureReason: 'Other',
    })]);
    expect(chipCount()).toBe(0);
    expect(getFlow().unfinishedHandoff).toBeNull();
  });

  it('failed completion clears the resume chip', async () => {
    const { getFlow } = mount();
    await emitResume('spot-1', { ...arrivedSpot });
    clickChip();
    await act(async () => { await getFlow().handleHandoffOutcome('failed'); });
    expect(getFlow().handoffStep).toBe('failure_reason');
    expect(getFlow().unfinishedHandoff?.id).toBe('spot-1');
    expect(chipCount()).toBe(0);

    await act(async () => { await getFlow().handleFailureReason('Someone else got it'); });

    expect(getFlow().handoffStep).toBeNull();
    expect(chipCount()).toBe(0);
    expect(documents.get('spotFeedback/spot-1_driver-1')).toMatchObject({
      outcome: 'failed',
      failureReason: 'Someone else got it',
    });
    expect(documents.get('spots/spot-1')?.claimState).toBe('arrived_pending_outcome');
    expect(documents.get('spots/spot-1')?.interestedUserId).toBe(user.id);
  });

  it('no unfinished arrived Ping means no chip', async () => {
    const { getFlow } = mount();
    await emit('spots', []);
    await emit('spotFeedback', []);
    expect(chipCount()).toBe(0);
    expect(getFlow().unfinishedHandoff).toBeNull();

    await emit('spots', [snapDoc('heading-1', {
      ...arrivedSpot,
      status: 'interested',
      claimState: 'heading',
    })]);
    await emit('spotFeedback', []);
    expect(chipCount()).toBe(0);

    await emit('spots', [snapDoc('spot-1', arrivedSpot)]);
    await emit('spotFeedback', [snapDoc('spot-1_driver-1', {
      spotId: 'spot-1',
      userId: user.id,
      outcome: 'success',
    })]);
    expect(chipCount()).toBe(0);
    expect(getFlow().unfinishedHandoff).toBeNull();
  });

  it('the normal claim to arrive to outcome path still works', async () => {
    const available = {
      id: 'spot-1',
      lat: 40.7,
      lng: -73.9,
      address: '1 Main St',
      title: '1 Main St',
      finderId: 'finder-1',
      finderName: 'Finder',
      geohash: 'dr5reg',
      status: 'available',
      type: 'free',
    };
    documents.set('spots/spot-1', { ...available });
    const { getFlow } = mount(available);
    await emit('spots', []);
    await emit('spotFeedback', []);
    expect(chipCount()).toBe(0);

    await act(async () => { await getFlow().handleExpressInterest(5); });
    expect(documents.get('spots/spot-1')).toMatchObject({
      status: 'interested',
      claimState: 'heading',
      interestedUserId: user.id,
    });
    expect(getFlow().handoffStep).toBeNull();
    expect(chipCount()).toBe(0);

    await act(async () => { await getFlow().handleArrival(); });
    expect(documents.get('spots/spot-1')).toMatchObject({
      status: 'occupied',
      claimState: 'arrived_pending_outcome',
      interestedUserId: user.id,
    });
    expect(getFlow().handoffStep).toBe('outcome');
    expect(getFlow().arriving).toBe(false);
    expect(getFlow().claiming).toBe(false);

    await emit('spots', [snapDoc('spot-1', documents.get('spots/spot-1')!)]);
    await emit('spotFeedback', []);
    expect(getFlow().handoffStep).toBe('outcome');
    expect(getFlow().unfinishedHandoff?.id).toBe('spot-1');
    expect(chipCount()).toBe(0);

    const arrived = arrivalFields(documents.get('spots/spot-1'));
    await dismissSheet();
    expect(getFlow().handoffStep).toBeNull();
    expect(chipCount()).toBe(1);
    expect(arrivalFields(documents.get('spots/spot-1'))).toEqual(arrived);
  });

  it('selects the latest open arrival and ignores terminal or non-arrived pings', () => {
    const chosen = selectUnfinishedHandoff([
      { id: 'older', data: { ...arrivedSpot, arrivedAt: { toMillis: () => 1 } } },
      { id: 'heading', data: { ...arrivedSpot, claimState: 'heading' } },
      { id: 'closed', data: { ...arrivedSpot, claimState: 'unconfirmed', arrivedAt: { toMillis: () => 50 } } },
      { id: 'done', data: { ...arrivedSpot, arrivedAt: { toMillis: () => 9 } } },
      { id: 'newer', data: { ...arrivedSpot, arrivedAt: { toMillis: () => 8 } } },
      { id: 'stranger', data: { ...arrivedSpot, interestedUserId: 'other' } },
    ], new Set(['done']), user.id);
    expect(chosen?.id).toBe('newer');
  });
});
