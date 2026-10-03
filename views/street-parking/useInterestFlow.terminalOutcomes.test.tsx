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
  addDoc, getDoc, getDocs, onSnapshot, runTransaction, setDoc, updateDoc,
} = vi.hoisted(() => ({
  addDoc: vi.fn(async (_collection: any, _data: any) => ({ id: 'notification' })),
  getDoc: vi.fn(async (_ref: any): Promise<any> => ({ exists: () => false, data: () => undefined })),
  getDocs: vi.fn(async () => ({ empty: true, docs: [] })),
  onSnapshot: vi.fn(() => () => {}),
  runTransaction: vi.fn(async (_db: any, _callback: any): Promise<any> => undefined),
  setDoc: vi.fn(async (_ref: any, _data: any) => {}),
  updateDoc: vi.fn(async (_ref: any, _data: any) => {}),
}));

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

function updatesTo(collection: string) {
  const calls = updateDoc.mock.calls as unknown as Array<[any, Record<string, any>]>;
  return calls.filter(([ref]) => ref.__col === collection);
}

describe('useInterestFlow — terminal handoff outcomes', () => {
  beforeEach(() => {
    addDoc.mockClear();
    getDoc.mockReset();
    getDocs.mockClear();
    runTransaction.mockReset();
    setDoc.mockReset();
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

  it('successful handoff reaches celebration without mutating the user root', async () => {
    const { getFlow } = mount();
    await arrive(getFlow);

    await act(async () => { await getFlow().handleHandoffOutcome('success'); });

    expect(getFlow().handoffStep).toBe('celebration');
    expect(getFlow().handoffSpotCoords).toEqual({ lat: 40.7, lng: -73.9, address: '1 Main St' });
    expect(documents.get('spots/spot-1')?.status).toBe('occupied');
    expect(writesTo('spotFeedback')).toHaveLength(1);
    expect(updatesTo('users')).toHaveLength(0);
  });

  it('finder-confirmed success atomically completes once with one deterministic notification', async () => {
    const finder = { id: 'finder-1', username: 'Finder', crowns: 0 };
    const { getFlow } = mount(finder);

    await act(async () => {
      await getFlow().handleFinderConfirmsArrival();
      await getFlow().handleFinderConfirmsArrival();
    });

    expect(runTransaction).toHaveBeenCalledTimes(2);
    expect(writesTo('spotFeedback')).toHaveLength(1);
    expect([...documents.keys()].filter((path) => path.startsWith('spotNotifications/'))).toHaveLength(1);
    expect(addDoc).toHaveBeenCalledTimes(0);
    expect(documents.get('spots/spot-1')?.status).toBe('occupied');
  });

  it('duplicate successful completion creates feedback and finder notification only once', async () => {
    const { getFlow } = mount();
    await arrive(getFlow);

    await act(async () => {
      await getFlow().handleHandoffOutcome('success');
      await getFlow().handleHandoffOutcome('success');
    });

    expect(writesTo('spotFeedback')).toHaveLength(1);
    expect([...documents.keys()].filter((path) => path.startsWith('spotNotifications/'))).toHaveLength(1);
    expect(addDoc).toHaveBeenCalledTimes(0);
  });

  it('retry after an already-committed successful terminal transaction restores celebration without duplicate state', async () => {
    documents.set('spotFeedback/spot-1_driver-1', {
      spotId: 'spot-1', userId: 'driver-1', finderId: 'finder-1',
      outcome: 'success', failureReason: null, address: '1 Main St',
    });
    documents.set('spotNotifications/handoff_success_spot-1_driver-1', {
      spotId: 'spot-1', senderId: 'driver-1', targetUserId: 'finder-1', type: 'handoff_success',
    });
    const { getFlow } = mount();
    await arrive(getFlow);

    await act(async () => { await getFlow().handleHandoffOutcome('success'); });

    expect(getFlow().handoffStep).toBe('celebration');
    expect(writesTo('spotFeedback')).toHaveLength(0);
    expect([...documents.keys()].filter((path) => path.startsWith('spotNotifications/'))).toHaveLength(1);
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

    runTransaction.mockRejectedValueOnce(error);
    await act(async () => { await findButton(renderer, "Yes, I'm in").props.onClick(); });

    expect(getFlow().handoffStep).toBe('outcome');
    expect(getFlow().handoffSubmitting).toBe(false);
    expect(getFlow().handoffSubmitError).toBe("Couldn't save this outcome.");
    expect(buttonText(renderer.root.findByProps({ 'data-testid': 'handoff-submit-error' }))).toContain("Couldn't save this outcome.");

    const gate = deferred();
    const writesBeforeRetry = runTransaction.mock.calls.length;
    runTransaction.mockImplementationOnce(() => gate.promise);
    let retryDone!: Promise<unknown>;
    act(() => { retryDone = findButton(renderer, 'Try again').props.onClick(); });

    expect(getFlow().handoffSubmitting).toBe(true);
    expect(getFlow().handoffStep).toBe('outcome');
    expect(renderer.root.findByProps({ 'data-testid': 'handoff-submit-pending' })).toBeTruthy();
    expect(runTransaction.mock.calls.length).toBe(writesBeforeRetry + 1);
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
    expect(runTransaction.mock.calls.length).toBe(writesBeforeRetry + 1);

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
    expect(writesTo('spotFeedback')).toHaveLength(0);
  });

  it('a success retry that resolves leaves the outcome controls and reaches celebration', async () => {
    const error = Object.assign(new Error('unavailable'), { code: 'unavailable' });
    const { getFlow, renderer } = mount(user, spot, true);
    await arrive(getFlow);

    runTransaction.mockRejectedValueOnce(error);
    await act(async () => { await findButton(renderer, "Yes, I'm in").props.onClick(); });
    expect(getFlow().handoffSubmitError).toBe("Couldn't save this outcome.");

    const gate = deferred();
    const writesBeforeRetry = runTransaction.mock.calls.length;
    runTransaction.mockImplementationOnce(() => gate.promise);
    let retryDone!: Promise<unknown>;
    act(() => { retryDone = findButton(renderer, 'Try again').props.onClick(); });

    expect(getFlow().handoffSubmitting).toBe(true);
    await act(async () => { await getFlow().handleHandoffOutcome('failed'); });
    expect(getFlow().handoffStep).toBe('outcome');
    expect(runTransaction.mock.calls.length).toBe(writesBeforeRetry + 1);

    await act(async () => {
      gate.resolve();
      await retryDone;
    });

    expect(getFlow().handoffSubmitting).toBe(false);
    expect(getFlow().handoffSubmitError).toBeNull();
    expect(getFlow().handoffStep).toBe('celebration');
  });
});
