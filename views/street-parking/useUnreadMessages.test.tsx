import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  const store = new Map<string, string>();
  (globalThis as any).localStorage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => store.set(key, String(value)),
    clear: () => store.clear(),
  };
  (globalThis as any).window = new EventTarget();
});

let snapshotHandler: ((snapshot: any) => void) | undefined;
let snapshotHandlers: Array<(snapshot: any) => void> = [];

vi.mock('../../firebase', () => ({ db: {} }));
vi.mock('firebase/firestore', () => ({
  collection: () => ({}),
  query: () => ({}),
  where: () => ({}),
  onSnapshot: (_query: unknown, handler: (snapshot: any) => void) => {
    snapshotHandler = handler;
    snapshotHandlers.push(handler);
    return () => {};
  },
}));

import { notifyChatRead, useUnreadMessages } from './useUnreadMessages';

function Harness({ userId }: { userId?: string }) {
  const count = useUnreadMessages(userId);
  return <span>{count}</span>;
}

const scopedReadKey = (userId: string, chatId: string) =>
  `lastReadChat_${JSON.stringify([userId, chatId])}`;

describe('useUnreadMessages', () => {
  beforeEach(() => {
    localStorage.clear();
    snapshotHandler = undefined;
    snapshotHandlers = [];
  });

  it('recomputes immediately when the active chat is marked read locally', () => {
    let renderer: TestRenderer.ReactTestRenderer;
    act(() => { renderer = TestRenderer.create(<Harness userId="me" />); });
    const timestamp = { toMillis: () => 100 };
    act(() => snapshotHandler?.({ docs: [{ id: 'chat-1', data: () => ({ lastMessageTimestamp: timestamp, lastSenderId: 'other' }) }] }));
    expect(renderer!.root.findByType('span').children).toEqual(['1']);

    localStorage.setItem(scopedReadKey('me', 'chat-1'), '101');
    act(() => notifyChatRead());
    expect(renderer!.root.findByType('span').children).toEqual(['0']);
    act(() => renderer!.unmount());
  });

  it('isolates the same chat read marker per account across account switches', () => {
    localStorage.setItem(scopedReadKey('account-a', 'shared-chat'), '101');
    let renderer: TestRenderer.ReactTestRenderer;
    act(() => { renderer = TestRenderer.create(<Harness userId="account-a" />); });
    const snapshot = { docs: [{ id: 'shared-chat', data: () => ({ lastMessageTimestamp: { toMillis: () => 100 }, lastSenderId: 'other' }) }] };
    act(() => snapshotHandler?.(snapshot));
    expect(renderer!.root.findByType('span').children).toEqual(['0']);

    act(() => { renderer!.update(<Harness userId="account-b" />); });
    act(() => snapshotHandler?.(snapshot));
    expect(renderer!.root.findByType('span').children).toEqual(['1']);

    localStorage.setItem(scopedReadKey('account-b', 'shared-chat'), '101');
    act(() => notifyChatRead());
    expect(renderer!.root.findByType('span').children).toEqual(['0']);

    act(() => { renderer!.update(<Harness userId="account-a" />); });
    act(() => snapshotHandler?.(snapshot));
    expect(renderer!.root.findByType('span').children).toEqual(['0']);
    act(() => renderer!.unmount());
  });

  it('does not attribute a legacy unscoped marker to the signed-in account', () => {
    localStorage.setItem('lastReadChat_chat-1', '101');
    let renderer: TestRenderer.ReactTestRenderer;
    act(() => { renderer = TestRenderer.create(<Harness userId="me" />); });
    act(() => snapshotHandler?.({ docs: [{ id: 'chat-1', data: () => ({ lastMessageTimestamp: { toMillis: () => 100 }, lastSenderId: 'other' }) }] }));
    expect(renderer!.root.findByType('span').children).toEqual(['1']);
    act(() => renderer!.unmount());
  });

  it('clears the previous account count before the next account snapshot arrives', () => {
    let renderer: TestRenderer.ReactTestRenderer;
    act(() => { renderer = TestRenderer.create(<Harness userId="account-a" />); });
    act(() => snapshotHandler?.({ docs: [{ id: 'chat-a', data: () => ({ lastMessageTimestamp: { toMillis: () => 100 }, lastSenderId: 'other' }) }] }));
    expect(renderer!.root.findByType('span').children).toEqual(['1']);

    act(() => { renderer!.update(<Harness userId="account-b" />); });
    expect(renderer!.root.findByType('span').children).toEqual(['0']);

    act(() => snapshotHandler?.({ docs: [{ id: 'chat-b', data: () => ({ lastMessageTimestamp: { toMillis: () => 100 }, lastSenderId: 'other' }) }] }));
    expect(renderer!.root.findByType('span').children).toEqual(['1']);
    act(() => { renderer!.update(<Harness />); });
    expect(renderer!.root.findByType('span').children).toEqual(['0']);
    act(() => renderer!.unmount());
  });

  it('ignores a previous account snapshot callback after switching users', () => {
    let renderer: TestRenderer.ReactTestRenderer;
    act(() => { renderer = TestRenderer.create(<Harness userId="account-a" />); });
    const accountAHandler = snapshotHandlers[0];
    act(() => { renderer!.update(<Harness userId="account-b" />); });
    const accountBHandler = snapshotHandlers[1];
    act(() => accountBHandler({ docs: [] }));
    expect(renderer!.root.findByType('span').children).toEqual(['0']);

    act(() => accountAHandler({ docs: [{ id: 'chat-a', data: () => ({ lastMessageTimestamp: { toMillis: () => 100 }, lastSenderId: 'other' }) }] }));
    expect(renderer!.root.findByType('span').children).toEqual(['0']);
    act(() => renderer!.unmount());
  });
});
