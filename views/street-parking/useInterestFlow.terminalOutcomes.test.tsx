import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

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

vi.mock('../../firebase', () => ({ db: {} }));

const {
  addDoc, getDoc, getDocs, onSnapshot, runTransaction, setDoc, updateDoc, spotListeners,
} = vi.hoisted(() => {
  const spotListeners = new Set<(snap: any) => void>();
  return {
    spotListeners,
    addDoc: vi.fn(async (_collection: any, _data: any) => ({ id: 'notification' })),
    getDoc: vi.fn(async (_ref: any): Promise<any> => ({ exists: () => false, data: () => undefined })),
    getDocs: vi.fn(async () => ({ empty: true, docs: [] })),
    onSnapshot: vi.fn((target: any, onNext: (snap: any) => void) => {
      if (target?.__col === 'spots') spotListeners.add(onNext);
      return () => spotListeners.delete(onNext);
    }),
    runTransaction: vi.fn(async (_db: any, _callback: any): Promise<any> => undefined),
    setDoc: vi.fn(async (_ref: any, _data: any) => {}),
    updateDoc: vi.fn(async (_ref: any, _data: any) => {}),
  };
});

vi.mock('firebase/firestore', () => ({
  addDoc,
  collection: vi.fn((_db, name) => ({ __collection: name })),
  deleteDoc: vi.fn(async () => {}),
  doc: vi.fn((_db, col, id) => ({ __col: col, __id: id })),
  getDoc,
  getDocs,
  increment: vi.fn((n: number) => ({ __increment: n })),
  limit: vi.fn(),
  onSnapshot,
  orderBy: vi.fn(),
  query: vi.fn((...args) => ({ __query: args })),
  runTransaction,
  setDoc,
  Timestamp: {
    fromMillis: (ms: number) => ({ toMillis: () => ms }),
    now: () => ({ toMillis: () => 1_000 }),
  },
  updateDoc,
  where: vi.fn(),
}));

vi.mock('./cancelClaimTransaction', () => ({ cancelClaimTransaction: vi.fn() }));
const { reportCriticalActionFailure } = vi.hoisted(() => ({ reportCriticalActionFailure: vi.fn() }));
vi.mock('../../utils/errorReporting', () => ({ reportCriticalActionFailure }));

import { useInterestFlow } from './useInterestFlow';
import { HandoffFlow } from './HandoffFlow';
import { selectUnfinishedHandoff } from './unfinishedHandoff';

const user = { id: 'driver-1', username: 'Driver', crowns: 0 };
const spot = {
  id: 'spot-1',
  lat: 40.7,
  lng: -73.9,
  address: '1 Main St',
  title: '1 Main St',
  type: 'free' as const,
  finderId: 'finder-1',
  finderName: 'Finder',
  interestedUserId: user.id,
  status: 'interested' as const,
};

const documents = new Map<string, Record<string, any>>();
const pathOf = (ref: { __col: string; __id: string }) => `${ref.__col}/${ref.__id}`;
const permissionDenied = () => Object.assign(new Error('permission denied'), { code: 'permission-denied' });

function snapshotFor(ref: { __col: string; __id: string }) {
  const data = documents.get(pathOf(ref));
  return {
    exists: () => data !== undefined,
    data: () => data,
  };
}

function mount(currentUser: typeof user = user, selected: typeof spot | Record<string, unknown> = spot, withSheet = false) {
  let flow!: ReturnType<typeof useInterestFlow>;
  const setSelectedItem = vi.fn();
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(
      <Harness
        onReady={(next) => { flow = next; }}
        setSelectedItem={setSelectedItem}
        currentUser={currentUser}
        selected={selected}
        withSheet={withSheet}
      />,
    );
  });
  return { getFlow: () => flow, setSelectedItem, renderer };
}

function Harness({
  onReady, setSelectedItem, currentUser = user, selected = spot, withSheet = false,
}: {
  onReady: (flow: ReturnType<typeof useInterestFlow>) => void;
  setSelectedItem: React.Dispatch<React.SetStateAction<any>>;
  currentUser?: typeof user;
  selected?: typeof spot | Record<string, unknown>;
  withSheet?: boolean;
}) {
  const flow = useInterestFlow({
    selectedItem: selected as typeof spot,
    setSelectedItem,
    user: currentUser,
    freeSpots: [selected as typeof spot],
    userLocation: null,
    mapRef: { current: null },
    activeRouteDestinationRef: { current: null },
  });
  onReady(flow);
  if (!withSheet || !flow.handoffStep) return null;
  return (
    <HandoffFlow
      step={flow.handoffStep}
      finderName={flow.handoffFinderName}
      onOutcome={flow.handleHandoffOutcome}
      onFailureReason={flow.handleFailureReason}
      onSetTimer={() => {}}
      onSkip={() => {}}
      submitError={flow.handoffSubmitError}
      submitting={flow.handoffSubmitting}
      onRetry={flow.retryTerminalHandoff}
    />
  );
}

async function arrive(getFlow: () => ReturnType<typeof useInterestFlow>) {
  await act(async () => { await getFlow().handleArrival(); });
  expect(getFlow().handoffStep).toBe('outcome');
}

function buttonText(node: TestRenderer.ReactTestInstance): string {
  return node.children.map((child) => (
    typeof child === 'string' ? child : buttonText(child)
  )).join('');
}

function findButton(renderer: TestRenderer.ReactTestRenderer, label: string) {
  return renderer.root.findAll((node) => node.type === 'button' && buttonText(node).includes(label))[0];
}

function deferred() {
  let resolve!: () => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function writesTo(collection: string) {
  const calls = setDoc.mock.calls as unknown as Array<[any, Record<string, any>]>;
  return calls.filter(([ref]) => ref.__col === collection);
}

function feedbackPaths() {
  return [...documents.keys()].filter((path) => path.startsWith('spotFeedback/')).sort();
}

function assertClientDidNotAward() {
  const payloads = [
    ...(setDoc.mock.calls as unknown as Array<[any, Record<string, any>]>).map(([, data]) => data),
    ...(updateDoc.mock.calls as unknown as Array<[any, Record<string, any>]>).map(([, data]) => data),
    ...(addDoc.mock.calls as unknown as Array<[any, Record<string, any>]>).map(([, data]) => data),
  ];
  for (const data of payloads) {
    expect(data?.outcome).not.toBe('success');
    expect(data?.outcome).not.toBe('completed_success');
    expect(data?.claimState).not.toBe('completed_success');
    expect(data?.claimState).not.toBe('unconfirmed');
    expect(data?.crowns).toBeUndefined();
    expect(data?.functionName).toBeUndefined();
  }
  expect(updatesTo('users')).toHaveLength(0);
  expect(writesTo('functionEvents')).toHaveLength(0);
  expect([...documents.keys()].some((path) => path.startsWith('functionEvents/'))).toBe(false);
  expect([...documents.keys()].some((path) => path.startsWith('users/'))).toBe(false);
}

async function emitServerAward() {
  await act(async () => {
    spotListeners.forEach((fn) => fn({
      data: () => ({ status: 'occupied', claimState: 'completed_success' }),
    }));
  });
}

function updatesTo(collection: string) {
  const calls = updateDoc.mock.calls as unknown as Array<[any, Record<string, any>]>;
  return calls.filter(([ref]) => ref.__col === collection);
}

function mountDurableFinder() {
  const finder = { id: 'finder-1', username: 'Finder', crowns: 0 };
  documents.set('spots/spot-1', {
    ...spot,
    status: 'occupied',
    claimState: 'arrived_pending_outcome',
    arrivedAt: { toMillis: () => Date.now() },
    interestedUserId: 'driver-1',
    interestedUserName: 'Driver',
  });
  return mount(finder, {
    ...spot,
    status: 'occupied',
    interestedUserId: 'driver-1',
    interestedUserName: 'Driver',
  }, true);
}

describe('useInterestFlow — terminal handoff outcomes', () => {
  beforeEach(() => {
    addDoc.mockClear();
    getDoc.mockReset();
    getDocs.mockClear();
    runTransaction.mockReset();
    setDoc.mockReset();
    spotListeners.clear();
    setDoc.mockImplementation(async (ref, data) => {
      if ((ref.__col === 'spotFeedback' || ref.__col === 'spotNotifications')
        && documents.has(pathOf(ref))) {
        throw permissionDenied();
      }
      documents.set(pathOf(ref), data);
    });
    updateDoc.mockReset();
    updateDoc.mockImplementation(async (ref, data) => {
      documents.set(pathOf(ref), { ...(documents.get(pathOf(ref)) ?? {}), ...data });
    });
    documents.clear();
    documents.set('spots/spot-1', { ...spot });
    reportCriticalActionFailure.mockClear();
    getDoc.mockImplementation(async (ref) => snapshotFor(ref));
    runTransaction.mockImplementation(async (_db, callback) => {
      const staged: Array<{ ref: any; data: Record<string, any>; merge?: boolean }> = [];
      const result = await callback({
        get: async (ref: any) => snapshotFor(ref),
        set: (ref: any, data: Record<string, any>) => staged.push({ ref, data }),
        update: (ref: any, data: Record<string, any>) => staged.push({ ref, data, merge: true }),
        delete: (_ref: any) => {},
      });
      if (staged.some(({ ref }) => ref.__col === 'spotFeedback' && documents.has(pathOf(ref)))) {
        throw permissionDenied();
      }
      for (const { ref, data, merge } of staged) {
        await setDoc(ref, merge ? { ...(documents.get(pathOf(ref)) ?? {}), ...data } : data);
      }
      return result;
    });
  });

  it('claimer success writes only the claimer participant_success doc and waits without Crowns copy', async () => {
    const { getFlow, renderer } = mount(user, spot, true);
    await arrive(getFlow);

    await act(async () => { await getFlow().handleHandoffOutcome('success'); });

    expect(getFlow().handoffStep).toBe('waiting');
    expect(getFlow().finderToast).toBeNull();
    expect(getFlow().driverNotification).toBeNull();
    expect(renderer.root.findByProps({ 'data-testid': 'handoff-waiting' })).toBeTruthy();
    expect(buttonText(renderer.root)).not.toMatch(/Crown|\+1|\+2/);
    expect(renderer.root.findAllByProps({ 'data-testid': 'handoff-crown-copy' })).toHaveLength(0);
    expect(getFlow().handoffSpotCoords).toEqual({ lat: 40.7, lng: -73.9, address: '1 Main St' });
    expect(documents.get('spots/spot-1')?.status).toBe('occupied');
    expect(documents.get('spots/spot-1')?.claimState).toBe('arrived_pending_outcome');
    expect(feedbackPaths()).toEqual(['spotFeedback/spot-1_driver-1']);
    expect(documents.get('spotFeedback/spot-1_driver-1')).toMatchObject({
      spotId: 'spot-1',
      userId: 'driver-1',
      finderId: 'finder-1',
      outcome: 'participant_success',
      role: 'claimer',
      failureReason: null,
      address: '1 Main St',
    });
    expect(documents.get('spotFeedback/spot-1_driver-1').createdAt.toMillis).toEqual(expect.any(Function));
    expect([...documents.keys()].filter((path) => path.startsWith('spotNotifications/'))).toHaveLength(0);
    expect(addDoc).toHaveBeenCalledTimes(0);
    assertClientDidNotAward();
  });

  it('finder success before durable arrival writes nothing and shows no Crowns toast', async () => {
    const finder = { id: 'finder-1', username: 'Finder', crowns: 0 };
    const { getFlow } = mount(finder);

    await act(async () => { await getFlow().handleFinderConfirmsArrival(); });

    expect(getFlow().handoffStep).toBeNull();
    expect(getFlow().finderToast).toBeNull();
    expect(feedbackPaths()).toEqual([]);
    expect(runTransaction).not.toHaveBeenCalled();
    expect(documents.get('spots/spot-1')?.status).toBe('interested');
    expect(documents.get('spots/spot-1')?.claimState).toBeUndefined();
    assertClientDidNotAward();
  });

  it('finder success writes only the finder doc after durable arrival and waits', async () => {
    const finder = { id: 'finder-1', username: 'Finder', crowns: 0 };
    documents.set('spots/spot-1', {
      ...spot,
      status: 'occupied',
      claimState: 'arrived_pending_outcome',
      arrivedAt: { toMillis: () => Date.now() },
      interestedUserId: 'driver-1',
      interestedUserName: 'Driver',
    });
    const { getFlow, renderer } = mount(finder, {
      ...spot,
      status: 'occupied',
      interestedUserId: 'driver-1',
      interestedUserName: 'Driver',
    }, true);

    await act(async () => {
      await getFlow().handleFinderConfirmsArrival();
      await getFlow().handleFinderConfirmsArrival();
    });

    expect(getFlow().handoffStep).toBe('waiting');
    expect(getFlow().finderToast).toBeNull();
    expect(renderer.root.findByProps({ 'data-testid': 'handoff-waiting' })).toBeTruthy();
    expect(buttonText(renderer.root)).not.toMatch(/Crown|\+1|\+2/);
    expect(feedbackPaths()).toEqual(['spotFeedback/spot-1_driver-1_finder']);
    expect(documents.get('spotFeedback/spot-1_driver-1_finder')).toMatchObject({
      spotId: 'spot-1',
      userId: 'driver-1',
      finderId: 'finder-1',
      outcome: 'participant_success',
      role: 'finder',
      failureReason: null,
      address: '1 Main St',
    });
    expect(documents.has('spotFeedback/spot-1_driver-1')).toBe(false);
    expect(documents.get('spots/spot-1')?.claimState).toBe('arrived_pending_outcome');
    expect([...documents.keys()].filter((path) => path.startsWith('spotNotifications/'))).toHaveLength(0);
    expect(addDoc).toHaveBeenCalledTimes(0);
    expect(runTransaction).not.toHaveBeenCalled();
    assertClientDidNotAward();
  });

  it('a rejected finder attestation shows a visible error', async () => {
    const error = Object.assign(new Error('unavailable'), { code: 'unavailable' });
    const { getFlow, renderer, setSelectedItem } = mountDurableFinder();
    setDoc.mockRejectedValueOnce(error);

    await act(async () => { await getFlow().handleFinderConfirmsArrival(); });

    expect(getFlow().handoffStep).toBe('finder_attest');
    expect(getFlow().handoffSubmitError).toBe("Couldn't save this outcome.");
    expect(reportCriticalActionFailure).toHaveBeenCalledWith('terminal_handoff', error);
    const alert = renderer.root.findByProps({ 'data-testid': 'handoff-submit-error' });
    expect(buttonText(alert)).toContain("Couldn't save this outcome.");
    expect(renderer.root.findByProps({ 'data-testid': 'finder-attest-error' })).toBeTruthy();
    expect(setSelectedItem).not.toHaveBeenCalledWith(null);
    expect(documents.get('spots/spot-1')?.claimState).toBe('arrived_pending_outcome');
    expect(feedbackPaths()).toEqual([]);
    expect(getFlow().finderToast).toBeNull();
    assertClientDidNotAward();
  });

  it('a rejected finder attestation keeps a retry action', async () => {
    const error = Object.assign(new Error('unavailable'), { code: 'unavailable' });
    const { getFlow, renderer } = mountDurableFinder();
    setDoc.mockRejectedValueOnce(error);

    await act(async () => { await getFlow().handleFinderConfirmsArrival(); });

    expect(getFlow().handoffSubmitting).toBe(false);
    const retry = renderer.root.findByProps({ 'data-testid': 'handoff-submit-retry' });
    expect(retry.props.disabled).toBe(false);
    expect(buttonText(retry)).toContain('Try again');
    expect(renderer.root.findAll((node) => node.type === 'button' && buttonText(node).includes('No luck'))).toHaveLength(0);
  });

  it('finder retry uses the deterministic finder attestation id', async () => {
    const error = Object.assign(new Error('unavailable'), { code: 'unavailable' });
    const { getFlow, renderer } = mountDurableFinder();
    setDoc.mockRejectedValueOnce(error);
    await act(async () => { await getFlow().handleFinderConfirmsArrival(); });

    const retry = renderer.root.findByProps({ 'data-testid': 'handoff-submit-retry' });
    await act(async () => { await retry.props.onClick(); });

    const feedbackWrites = writesTo('spotFeedback');
    expect(feedbackWrites).toHaveLength(2);
    for (const call of feedbackWrites) {
      expect(call).toHaveLength(2);
      expect(call[0]).toMatchObject({ __col: 'spotFeedback', __id: 'spot-1_driver-1_finder' });
      expect(call[1]).toMatchObject({
        outcome: 'participant_success',
        role: 'finder',
        userId: 'driver-1',
        finderId: 'finder-1',
        failureReason: null,
      });
    }
    expect(documents.get('spotFeedback/spot-1_driver-1_finder')?.outcome).toBe('participant_success');
    expect(documents.has('spotFeedback/spot-1_driver-1')).toBe(false);
  });

  it('a duplicate finder retry cannot fire while a submission is in flight', async () => {
    const error = Object.assign(new Error('unavailable'), { code: 'unavailable' });
    const { getFlow, renderer } = mountDurableFinder();
    setDoc.mockRejectedValueOnce(error);
    await act(async () => { await getFlow().handleFinderConfirmsArrival(); });

    const gate = deferred();
    const writesBeforeRetry = setDoc.mock.calls.length;
    setDoc.mockImplementationOnce(async (ref, data) => {
      documents.set(pathOf(ref), data);
      await gate.promise;
    });
    let retryDone!: Promise<unknown>;
    act(() => {
      retryDone = renderer.root.findByProps({ 'data-testid': 'handoff-submit-retry' }).props.onClick();
    });
    await act(async () => { await Promise.resolve(); });

    expect(getFlow().handoffSubmitting).toBe(true);
    expect(getFlow().handoffStep).toBe('finder_attest');
    expect(setDoc.mock.calls.length).toBe(writesBeforeRetry + 1);
    expect(setDoc.mock.calls.at(-1)?.[0]).toMatchObject({
      __col: 'spotFeedback',
      __id: 'spot-1_driver-1_finder',
    });
    expect(renderer.root.findByProps({ 'data-testid': 'handoff-submit-pending' })).toBeTruthy();
    expect(renderer.root.findAllByProps({ 'data-testid': 'handoff-submit-retry' })).toHaveLength(0);

    await act(async () => {
      await getFlow().retryTerminalHandoff();
      await getFlow().handleFinderConfirmsArrival();
    });

    expect(setDoc.mock.calls.length).toBe(writesBeforeRetry + 1);
    expect(getFlow().handoffStep).toBe('finder_attest');
    expect(documents.get('spots/spot-1')?.claimState).toBe('arrived_pending_outcome');

    await act(async () => {
      gate.resolve();
      await retryDone;
    });
  });

  it('a successful finder retry returns to waiting for mutual confirmation', async () => {
    const error = Object.assign(new Error('unavailable'), { code: 'unavailable' });
    const { getFlow, renderer } = mountDurableFinder();
    setDoc.mockRejectedValueOnce(error);
    await act(async () => { await getFlow().handleFinderConfirmsArrival(); });
    expect(getFlow().handoffStep).toBe('finder_attest');

    await act(async () => {
      await renderer.root.findByProps({ 'data-testid': 'handoff-submit-retry' }).props.onClick();
    });

    expect(getFlow().handoffSubmitting).toBe(false);
    expect(getFlow().handoffSubmitError).toBeNull();
    expect(getFlow().handoffStep).toBe('waiting');
    expect(renderer.root.findByProps({ 'data-testid': 'handoff-waiting' })).toBeTruthy();
    expect(buttonText(renderer.root.findByProps({ 'data-testid': 'handoff-waiting' }))).toContain('Waiting on the other driver');
    expect(documents.get('spots/spot-1')?.claimState).toBe('arrived_pending_outcome');
    expect(documents.get('spotFeedback/spot-1_driver-1_finder')).toMatchObject({
      outcome: 'participant_success',
      role: 'finder',
      userId: 'driver-1',
    });
    expect(getFlow().finderToast).toBeNull();
    expect(getFlow().driverNotification).toBeNull();
  });

  it('no Crown copy appears before the server claimState is completed_success', async () => {
    const error = Object.assign(new Error('unavailable'), { code: 'unavailable' });
    const { getFlow, renderer } = mountDurableFinder();
    setDoc.mockRejectedValueOnce(error);
    await act(async () => { await getFlow().handleFinderConfirmsArrival(); });

    expect(buttonText(renderer.root)).not.toMatch(/Crown|\+1|\+2/);
    expect(renderer.root.findAllByProps({ 'data-testid': 'handoff-crown-copy' })).toHaveLength(0);
    expect(getFlow().finderToast).toBeNull();
    expect(documents.get('spots/spot-1')?.claimState).toBe('arrived_pending_outcome');

    await act(async () => {
      await renderer.root.findByProps({ 'data-testid': 'handoff-submit-retry' }).props.onClick();
    });

    expect(getFlow().handoffStep).toBe('waiting');
    expect(buttonText(renderer.root)).not.toMatch(/Crown|\+1|\+2/);
    expect(renderer.root.findAllByProps({ 'data-testid': 'handoff-crown-copy' })).toHaveLength(0);
    expect(getFlow().finderToastTitle).toBeNull();
    expect(getFlow().finderToast).toBeNull();
    expect(getFlow().driverNotification).toBeNull();
    expect(documents.get('spots/spot-1')?.claimState).toBe('arrived_pending_outcome');
    assertClientDidNotAward();
  });

  it('duplicate claimer confirmation keeps a single claimer doc and does not notify', async () => {
    const { getFlow } = mount();
    await arrive(getFlow);

    await act(async () => {
      await getFlow().handleHandoffOutcome('success');
      await getFlow().handleHandoffOutcome('success');
    });

    expect(getFlow().handoffStep).toBe('waiting');
    expect(feedbackPaths()).toEqual(['spotFeedback/spot-1_driver-1']);
    expect(documents.get('spotFeedback/spot-1_driver-1').outcome).toBe('participant_success');
    expect([...documents.keys()].filter((path) => path.startsWith('spotNotifications/'))).toHaveLength(0);
    expect(addDoc).toHaveBeenCalledTimes(0);
    assertClientDidNotAward();
  });

  it('an existing claimer attestation reopens waiting without a second write or Crowns copy', async () => {
    documents.set('spotFeedback/spot-1_driver-1', {
      spotId: 'spot-1', userId: 'driver-1', finderId: 'finder-1',
      outcome: 'participant_success', role: 'claimer', failureReason: null, address: '1 Main St',
    });
    const { getFlow } = mount();
    await arrive(getFlow);
    const seeded = documents.get('spotFeedback/spot-1_driver-1');

    await act(async () => { await getFlow().handleHandoffOutcome('success'); });

    expect(getFlow().handoffStep).toBe('waiting');
    expect(getFlow().finderToast).toBeNull();
    expect(documents.get('spotFeedback/spot-1_driver-1')).toBe(seeded);
    expect(feedbackPaths()).toEqual(['spotFeedback/spot-1_driver-1']);
    expect(seeded.outcome).toBe('participant_success');
    assertClientDidNotAward();
  });

  it('sends claimer +1 only after the server award and never tells the claimer +2', async () => {
    const { getFlow, renderer } = mount(user, spot, true);
    await arrive(getFlow);
    await act(async () => { await getFlow().handleHandoffOutcome('success'); });
    expect(getFlow().handoffStep).toBe('waiting');
    expect(renderer.root.findAllByProps({ 'data-testid': 'handoff-crown-copy' })).toHaveLength(0);

    await emitServerAward();

    expect(getFlow().handoffStep).toBe('celebration');
    expect(buttonText(renderer.root.findByProps({ 'data-testid': 'handoff-crown-copy' }))).toBe('+1 Crown earned');
    expect(buttonText(renderer.root)).not.toContain('+2');
    expect(getFlow().finderToast ?? '').not.toContain('+2');
    expect(getFlow().driverNotification ?? '').not.toContain('+2');
    assertClientDidNotAward();
  });

  it('sends finder +2 only after the server award', async () => {
    const finder = { id: 'finder-1', username: 'Finder', crowns: 0 };
    documents.set('spots/spot-1', {
      ...spot,
      status: 'occupied',
      claimState: 'arrived_pending_outcome',
      arrivedAt: { toMillis: () => Date.now() },
      interestedUserName: 'Driver',
    });
    const { getFlow } = mount(finder, {
      ...spot,
      interestedUserName: 'Driver',
    });
    await act(async () => { await getFlow().handleFinderConfirmsArrival(); });
    expect(getFlow().finderToast).toBeNull();
    expect(getFlow().handoffStep).toBe('waiting');

    await emitServerAward();

    expect(getFlow().handoffStep).toBeNull();
    expect(getFlow().finderToastTitle).toBe('+2 Crowns earned');
    expect(getFlow().finderToast).toContain('Driver');
    expect(getFlow().finderToast).toContain('+2 Crowns earned');
    expect(getFlow().finderToast).not.toContain('+1');
    expect(getFlow().driverNotification).toBeNull();
    assertClientDidNotAward();
  });

  it('a dismissed claimer still hears +1, not +2, after the server award', async () => {
    const { getFlow } = mount();
    await arrive(getFlow);
    await act(async () => { await getFlow().handleHandoffOutcome('success'); });
    act(() => { getFlow().handleSkipDeparture(); });
    expect(getFlow().handoffStep).toBeNull();

    await emitServerAward();

    expect(getFlow().driverNotification).toBe('+1 Crown earned');
    expect(getFlow().driverNotifTitle).toBe("You're parked!");
    expect(getFlow().finderToast).toBeNull();
    expect(`${getFlow().driverNotification} ${getFlow().driverNotifTitle}`).not.toContain('+2');
  });

  it('choosing failed only opens the reason step and performs no feedback write', async () => {
    const { getFlow } = mount();
    await arrive(getFlow);

    await act(async () => { await getFlow().handleHandoffOutcome('failed'); });

    expect(getFlow().handoffStep).toBe('failure_reason');
    expect(writesTo('spotFeedback')).toHaveLength(0);
  });

  it('failed handoff creates one complete immutable feedback document and closes the flow', async () => {
    const { getFlow, setSelectedItem } = mount();
    await arrive(getFlow);
    await act(async () => { await getFlow().handleHandoffOutcome('failed'); });

    await act(async () => { await getFlow().handleFailureReason('Someone else got it'); });

    expect(writesTo('spotFeedback')).toHaveLength(1);
    expect(writesTo('spotFeedback')[0][1]).toMatchObject({
      outcome: 'failed',
      failureReason: 'Someone else got it',
    });
    expect(updatesTo('spotFeedback')).toHaveLength(0);
    expect(documents.get('spots/spot-1')?.status).toBe('occupied');
    expect(getFlow().handoffStep).toBeNull();
    expect(setSelectedItem).toHaveBeenCalledWith(null);
  });

  it('duplicate failed submission creates feedback only once', async () => {
    const { getFlow } = mount();
    await arrive(getFlow);
    await act(async () => { await getFlow().handleHandoffOutcome('failed'); });

    await act(async () => {
      await getFlow().handleFailureReason("Finder hadn't left yet");
      await getFlow().handleFailureReason("Finder hadn't left yet");
    });

    expect(writesTo('spotFeedback')).toHaveLength(1);
    expect(writesTo('spotFeedback')[0][1]).toMatchObject({
      outcome: 'failed',
      failureReason: "Finder hadn't left yet",
    });
    expect(updatesTo('spotFeedback')).toHaveLength(0);
  });

  it('retry after already-committed failed feedback closes cleanly without another write', async () => {
    documents.set('spotFeedback/spot-1_driver-1', {
      spotId: 'spot-1', userId: 'driver-1', finderId: 'finder-1',
      outcome: 'failed', failureReason: "Couldn't find the location", address: '1 Main St',
    });
    const { getFlow } = mount();
    await arrive(getFlow);
    await act(async () => { await getFlow().handleHandoffOutcome('failed'); });

    await act(async () => { await getFlow().handleFailureReason("Couldn't find the location"); });

    expect(getFlow().handoffStep).toBeNull();
    expect(writesTo('spotFeedback')).toHaveLength(0);
  });

  it('invalid failed-handoff reason is rejected without writing or closing the flow', async () => {
    const { getFlow } = mount();
    await arrive(getFlow);
    await act(async () => { await getFlow().handleHandoffOutcome('failed'); });

    await expect(getFlow().handleFailureReason('arbitrary user text')).rejects.toThrow('Invalid handoff failure reason');

    expect(writesTo('spotFeedback')).toHaveLength(0);
    expect(getFlow().handoffStep).toBe('failure_reason');
  });

  it('a failed terminal write preserves the current step and remains retryable', async () => {
    const error = Object.assign(new Error('unavailable'), { code: 'unavailable' });
    const { getFlow } = mount();
    await arrive(getFlow);
    // Arrival now commits through the same transaction helper, which applies
    // its spot update via setDoc. Reject only the following terminal write.
    setDoc.mockRejectedValueOnce(error);

    await act(async () => { await getFlow().handleHandoffOutcome('success'); });

    expect(getFlow().handoffStep).toBe('outcome');
    expect(getFlow().handoffSubmitError).toBe("Couldn't save this outcome.");
    expect(reportCriticalActionFailure).toHaveBeenCalledWith('terminal_handoff', error);
  });

  it('a reason click runs the handler, and a rejected write stays visible inside the sheet', async () => {
    const denied = Object.assign(new Error('Missing or insufficient permissions.'), { code: 'permission-denied' });
    const { getFlow, renderer } = mount(user, spot, true);
    await arrive(getFlow);

    const noLuck = findButton(renderer, 'No luck');
    await act(async () => { noLuck.props.onClick(); });
    expect(getFlow().handoffStep).toBe('failure_reason');

    runTransaction.mockRejectedValueOnce(denied);
    const reason = renderer.root.findAll((node) => (
      typeof node.props.className === 'string' && node.props.className.includes('handoff-failure-reason')
    ))[0];
    await act(async () => { await reason.props.onClick(); });

    expect(runTransaction).toHaveBeenCalled();
    expect(writesTo('spotFeedback')).toHaveLength(0);
    expect(getFlow().handoffStep).toBe('failure_reason');
    expect(getFlow().handoffSubmitError).toBe("Couldn't save this outcome.");
    expect(reportCriticalActionFailure).toHaveBeenCalledWith('terminal_handoff', denied);
    const alert = renderer.root.findByProps({ 'data-testid': 'handoff-submit-error' });
    expect(buttonText(alert)).toContain("Couldn't save this outcome.");

    const retry = renderer.root.findByProps({ 'data-testid': 'handoff-submit-retry' });
    await act(async () => { await retry.props.onClick(); });
    expect(getFlow().handoffStep).toBeNull();
    expect(writesTo('spotFeedback')).toHaveLength(1);
    expect(writesTo('spotFeedback')[0][1]).toMatchObject({
      outcome: 'failed',
      failureReason: 'Someone else got it',
    });
  });

  it('the recorded canary shape throws Handoff participants changed before any feedback write', async () => {
    const driver = { id: 'RLWYDF4op5WOJj0ivZvzcAJGY5M2', username: 'AndroidTest', crowns: 0 };
    const canaryId = 'b2-chip-canary-20261002';
    const canary = {
      ...spot,
      id: canaryId,
      lat: -77,
      lng: 0,
      address: 'SYNTHETIC B2 CHIP CHECK',
      title: 'SYNTHETIC B2 CHIP CHECK',
      finderName: 'B2 canary',
      finderId: '',
      status: 'occupied' as const,
      interestedUserId: driver.id,
    };
    const canaryData = {
      lat: -77,
      lng: 0,
      address: 'SYNTHETIC B2 CHIP CHECK',
      finderName: 'B2 canary',
      status: 'occupied',
      claimState: 'arrived_pending_outcome',
      interestedUserId: driver.id,
      arrivedAt: { toMillis: () => 1_759_000_000_000 },
    };
    documents.set(`spots/${canaryId}`, canaryData);
    expect(selectUnfinishedHandoff(
      [{ id: canaryId, data: canaryData }],
      new Set(),
      driver.id,
    )?.finderId).toBe('');
    const { getFlow } = mount(driver, canary);
    await arrive(getFlow);
    await act(async () => { await getFlow().handleHandoffOutcome('failed'); });

    await act(async () => { await getFlow().handleFailureReason("Couldn't find the location"); });

    expect(getFlow().handoffStep).toBe('failure_reason');
    expect(getFlow().handoffSubmitError).toBe("Couldn't save this outcome.");
    expect(writesTo('spotFeedback')).toHaveLength(0);
    const reported = reportCriticalActionFailure.mock.calls.at(-1);
    expect(reported?.[0]).toBe('terminal_handoff');
    expect(reported?.[1]).toMatchObject({ message: 'Handoff participants changed' });
    expect(`spotFeedback/${canaryId}_${driver.id}`).toBe('spotFeedback/b2-chip-canary-20261002_RLWYDF4op5WOJj0ivZvzcAJGY5M2');
  });

  it('an in-flight success retry holds the submit lock over No luck and a second retry', async () => {
    const error = Object.assign(new Error('unavailable'), { code: 'unavailable' });
    const { getFlow, renderer } = mount(user, spot, true);
    await arrive(getFlow);

    setDoc.mockRejectedValueOnce(error);
    await act(async () => { await findButton(renderer, "Yes, I'm in").props.onClick(); });

    expect(getFlow().handoffStep).toBe('outcome');
    expect(getFlow().handoffSubmitting).toBe(false);
    expect(getFlow().handoffSubmitError).toBe("Couldn't save this outcome.");
    expect(buttonText(renderer.root.findByProps({ 'data-testid': 'handoff-submit-error' }))).toContain("Couldn't save this outcome.");

    const gate = deferred();
    const writesBeforeRetry = setDoc.mock.calls.length;
    setDoc.mockImplementationOnce(() => gate.promise);
    let retryDone!: Promise<unknown>;
    act(() => { retryDone = findButton(renderer, 'Try again').props.onClick(); });
    await act(async () => { await Promise.resolve(); });

    expect(getFlow().handoffSubmitting).toBe(true);
    expect(getFlow().handoffStep).toBe('outcome');
    expect(renderer.root.findByProps({ 'data-testid': 'handoff-submit-pending' })).toBeTruthy();
    expect(setDoc.mock.calls.length).toBe(writesBeforeRetry + 1);
    expect(findButton(renderer, "Yes, I'm in").props.disabled).toBe(true);
    expect(findButton(renderer, 'No luck').props.disabled).toBe(true);
    expect(renderer.root.findAllByProps({ 'data-testid': 'handoff-submit-retry' })).toHaveLength(0);

    await act(async () => {
      findButton(renderer, 'No luck').props.onClick();
      await getFlow().handleHandoffOutcome('failed');
      await getFlow().retryTerminalHandoff();
      findButton(renderer, "Yes, I'm in").props.onClick();
    });

    expect(getFlow().handoffStep).toBe('outcome');
    expect(getFlow().handoffSubmitting).toBe(true);
    expect(setDoc.mock.calls.length).toBe(writesBeforeRetry + 1);

    await act(async () => {
      gate.reject(error);
      await retryDone;
    });

    expect(getFlow().handoffSubmitting).toBe(false);
    expect(getFlow().handoffStep).toBe('outcome');
    expect(getFlow().handoffSubmitError).toBe("Couldn't save this outcome.");
    const noLuck = findButton(renderer, 'No luck');
    const retry = renderer.root.findByProps({ 'data-testid': 'handoff-submit-retry' });
    expect(noLuck.props.disabled).toBe(false);
    expect(findButton(renderer, "Yes, I'm in").props.disabled).toBe(false);
    expect(retry.props.disabled).toBe(false);

    await act(async () => { await noLuck.props.onClick(); });
    expect(getFlow().handoffStep).toBe('failure_reason');
    expect(feedbackPaths()).toEqual([]);
  });

  it('a success retry that resolves leaves the outcome controls and waits for the award', async () => {
    const error = Object.assign(new Error('unavailable'), { code: 'unavailable' });
    const { getFlow, renderer } = mount(user, spot, true);
    await arrive(getFlow);

    setDoc.mockRejectedValueOnce(error);
    await act(async () => { await findButton(renderer, "Yes, I'm in").props.onClick(); });
    expect(getFlow().handoffSubmitError).toBe("Couldn't save this outcome.");

    const gate = deferred();
    const writesBeforeRetry = setDoc.mock.calls.length;
    setDoc.mockImplementationOnce(() => gate.promise);
    let retryDone!: Promise<unknown>;
    act(() => { retryDone = findButton(renderer, 'Try again').props.onClick(); });

    expect(getFlow().handoffSubmitting).toBe(true);
    await act(async () => { await getFlow().handleHandoffOutcome('failed'); });
    expect(getFlow().handoffStep).toBe('outcome');
    expect(setDoc.mock.calls.length).toBe(writesBeforeRetry + 1);

    await act(async () => {
      gate.resolve();
      await retryDone;
    });

    expect(getFlow().handoffSubmitting).toBe(false);
    expect(getFlow().handoffSubmitError).toBeNull();
    expect(getFlow().handoffStep).toBe('waiting');
    expect(renderer.root.findAllByProps({ 'data-testid': 'handoff-crown-copy' })).toHaveLength(0);

    await emitServerAward();

    expect(getFlow().handoffStep).toBe('celebration');
    expect(buttonText(renderer.root.findByProps({ 'data-testid': 'handoff-crown-copy' }))).toBe('+1 Crown earned');
    expect(buttonText(renderer.root)).not.toContain('+2');
  });
});
