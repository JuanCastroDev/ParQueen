import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const store = vi.hoisted(() => {
    const map = new Map<string, string>();
    Object.defineProperty(globalThis, 'localStorage', {
        configurable: true,
        value: {
            getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
            setItem: (k: string, v: string) => { map.set(k, String(v)); },
            removeItem: (k: string) => { map.delete(k); },
            clear: () => { map.clear(); },
        },
    });
    return map;
});

vi.mock('../hooks/useFocusOnMount', () => ({ useFocusOnMount: vi.fn() }));
vi.mock('../firebase', () => ({ db: { name: 'db' } }));
vi.mock('firebase/firestore', () => ({
    doc: vi.fn((_db: unknown, _col: string, uid: string) => ({ id: uid })),
    getDoc: vi.fn(),
}));
vi.mock('../utils/unblockUser', () => ({ unblockUser: vi.fn() }));

import { getDoc } from 'firebase/firestore';
import { BlockedUsersView } from './BlockedUsersView';
import { unblockUser } from '../utils/unblockUser';
import { setLang } from '../i18n';

const textOf = (n: any): string => typeof n === 'string' ? n : (n?.children ?? []).map(textOf).join('');

function render(blockedUsers: string[] = []) {
    let r!: TestRenderer.ReactTestRenderer;
    const onBack = vi.fn();
    act(() => {
        r = TestRenderer.create(
            <BlockedUsersView user={{ id: 'me', blockedUsers }} onBack={onBack} />,
        );
    });
    return { r, onBack };
}

async function flush() {
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
}

beforeEach(() => {
    store.clear();
    vi.mocked(getDoc).mockReset();
    vi.mocked(unblockUser).mockReset();
    vi.mocked(getDoc).mockImplementation((async (ref: { id?: string }) => {
        if (ref.id === 'secret-uid') {
            return { exists: () => true, data: () => ({ username: 'parkpal', avatarUrl: 'https://cdn.example/a.png', email: 'hidden@example.com' }) };
        }
        return { exists: () => false, data: () => ({}) };
    }) as typeof getDoc);
});

afterEach(() => setLang('en'));

describe('BlockedUsersView', () => {
    it('BU-04 BU-05: hydrates username and avatar and never shows the UID', async () => {
        const { r } = render(['secret-uid']);
        await flush();
        const text = textOf(r.toJSON());
        expect(text).toContain('parkpal');
        expect(text).not.toContain('secret-uid');
        expect(text).not.toContain('hidden@example.com');
        const img = r.root.findByType('img');
        expect(img.props.src).toBe('https://cdn.example/a.png');
        expect(img.props.alt).toBe('');
    });

    it('BU-06: a missing profile still offers Unblock under a generic name', async () => {
        const { r } = render(['missing-uid']);
        await flush();
        const text = textOf(r.toJSON());
        expect(text).toContain('Blocked user');
        expect(text).not.toContain('missing-uid');
        const button = r.root.findByProps({ 'aria-label': 'Unblock Blocked user' });
        vi.mocked(unblockUser).mockResolvedValue(undefined);
        await act(async () => { button.props.onClick(); });
        expect(unblockUser).toHaveBeenCalledWith({ name: 'db' }, 'me', 'missing-uid');
    });

    it('BU-10: a failed unblock keeps the row and exposes an error that can be retried', async () => {
        const { r } = render(['secret-uid']);
        await flush();
        vi.mocked(unblockUser).mockRejectedValueOnce(new Error('nope'));
        const button = () => r.root.findByProps({ 'aria-label': 'Unblock parkpal' });
        await act(async () => { button().props.onClick(); });
        expect(textOf(r.toJSON())).toContain('parkpal');
        expect(r.root.findByProps({ role: 'alert' }).children).toContain('Failed to unblock. Try again.');
        vi.mocked(unblockUser).mockResolvedValueOnce(undefined);
        await act(async () => { button().props.onClick(); });
        expect(unblockUser).toHaveBeenCalledTimes(2);
        expect(r.root.findByProps({ role: 'status' }).children).toContain('User unblocked.');
    });

    it('BU-11: an empty list renders the empty state', () => {
        const { r } = render([]);
        const text = textOf(r.toJSON());
        expect(text).toContain('No blocked users');
        expect(text).toContain("You haven't blocked anyone.");
        expect(r.root.findAllByType('li')).toHaveLength(0);
    });

    it('BU-12: a second tap while unblock is in flight does not write again', async () => {
        const { r } = render(['secret-uid']);
        await flush();
        let release!: () => void;
        vi.mocked(unblockUser).mockImplementation(() => new Promise(resolve => { release = resolve; }));
        const button = () => r.root.findByProps({ 'aria-label': 'Unblock parkpal' });
        act(() => { button().props.onClick(); });
        act(() => { button().props.onClick(); });
        expect(unblockUser).toHaveBeenCalledTimes(1);
        expect(button().props.disabled).toBe(true);
        expect(button().props['aria-busy']).toBe(true);
        await act(async () => { release(); });
        expect(button().props.disabled).toBe(false);
    });

    it('names the heading and the back control', () => {
        const { r, onBack } = render([]);
        const h1 = r.root.findByType('h1');
        expect(textOf(h1)).toBe('Blocked users');
        expect(h1.props.tabIndex).toBe(-1);
        act(() => r.root.findByProps({ 'aria-label': 'Back to Settings' }).props.onClick());
        expect(onBack).toHaveBeenCalledTimes(1);
    });
});
