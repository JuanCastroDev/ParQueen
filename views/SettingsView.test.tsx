import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

const nativeShare = vi.hoisted(() => ({
    getPlatform: vi.fn(() => 'web'),
    share: vi.fn(),
}));

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
vi.mock('../firebase', () => ({ db: {} }));
vi.mock('firebase/firestore', () => ({ doc: vi.fn(), updateDoc: vi.fn() }));
vi.mock('firebase/functions', () => ({ getFunctions: vi.fn(), httpsCallable: vi.fn() }));
vi.mock('firebase/app', () => ({ getApp: vi.fn() }));
vi.mock('@capacitor/core', () => ({ Capacitor: { getPlatform: nativeShare.getPlatform } }));
vi.mock('@capacitor/share', () => ({ Share: { share: nativeShare.share } }));

import { SettingsView } from './SettingsView';
import { AppView } from '../types';
import { setLang } from '../i18n';

const textOf = (n: any): string => typeof n === 'string' ? n : (n?.children ?? []).map(textOf).join('');

function render(props: Partial<React.ComponentProps<typeof SettingsView>> = {}) {
    const spies = { setView: vi.fn(), onBack: vi.fn(), onLogout: vi.fn(), onDeleteAccount: vi.fn(), toggleTheme: vi.fn() };
    let r!: TestRenderer.ReactTestRenderer;
    act(() => {
        r = TestRenderer.create(
            <SettingsView user={{ email: 'driver@example.com', emailVerified: true, notificationRadius: 2 }} theme="dark" {...spies} {...props} />,
        );
    });
    const rowNamed = (label: string) => r.root.findAll(n => (n.type === 'button' || n.type === 'a') && (n.props['aria-label'] === label || textOf(n).includes(label)))[0];
    return { r, spies, rowNamed };
}

afterEach(() => {
    setLang('en');
    nativeShare.getPlatform.mockReturnValue('web');
    nativeShare.share.mockReset();
    vi.unstubAllGlobals();
});

describe('SettingsView — Share ParQueen', () => {
    it('opens the Android share chooser with the public ParQueen URL', async () => {
        nativeShare.getPlatform.mockReturnValue('android');
        nativeShare.share.mockResolvedValue({ activityType: 'com.example.target' });
        const webShare = vi.fn();
        vi.stubGlobal('navigator', { share: webShare });
        const { r, rowNamed } = render();

        await act(async () => rowNamed('Share ParQueen').props.onClick());

        expect(nativeShare.share).toHaveBeenCalledWith({
            title: 'ParQueen',
            text: 'Street parking, figured out. See what ParQueen can do.',
            url: 'https://parqueen.app/',
            dialogTitle: 'Share ParQueen',
        });
        expect(webShare).not.toHaveBeenCalled();
        expect(textOf(r.toJSON())).toContain('Shared.');
    });

    it('treats closing the Android share chooser as cancellation, not an error', async () => {
        nativeShare.getPlatform.mockReturnValue('android');
        nativeShare.share.mockRejectedValue(new Error('Share canceled'));
        const writeText = vi.fn();
        vi.stubGlobal('navigator', { clipboard: { writeText } });
        const { r, rowNamed } = render();

        await act(async () => rowNamed('Share ParQueen').props.onClick());

        expect(writeText).not.toHaveBeenCalled();
        expect(r.root.findAllByProps({ href: 'https://parqueen.app/' })).toHaveLength(0);
    });

    it('does not report success when the Android chooser closes without a target', async () => {
        nativeShare.getPlatform.mockReturnValue('android');
        nativeShare.share.mockResolvedValue({ activityType: '' });
        const writeText = vi.fn();
        vi.stubGlobal('navigator', { clipboard: { writeText } });
        const { r, rowNamed } = render();

        await act(async () => rowNamed('Share ParQueen').props.onClick());

        expect(writeText).not.toHaveBeenCalled();
        expect(textOf(r.toJSON())).not.toContain('Shared.');
        expect(r.root.findAllByProps({ href: 'https://parqueen.app/' })).toHaveLength(0);
    });

    it('copies the link when Android native sharing fails', async () => {
        nativeShare.getPlatform.mockReturnValue('android');
        nativeShare.share.mockRejectedValue(new Error('share failed'));
        const writeText = vi.fn().mockResolvedValue(undefined);
        vi.stubGlobal('navigator', { clipboard: { writeText } });
        const { r, rowNamed } = render();

        await act(async () => rowNamed('Share ParQueen').props.onClick());

        expect(writeText).toHaveBeenCalledWith('https://parqueen.app/');
        expect(textOf(r.toJSON())).toContain('Link copied.');
    });

    it('uses Web Share directly on Web/PWA with the public ParQueen URL', async () => {
        const share = vi.fn().mockResolvedValue(undefined);
        vi.stubGlobal('navigator', { share });
        const { r, rowNamed } = render();

        await act(async () => rowNamed('Share ParQueen').props.onClick());

        expect(share).toHaveBeenCalledWith({
            title: 'ParQueen',
            text: 'Street parking, figured out. See what ParQueen can do.',
            url: 'https://parqueen.app/',
        });
        expect(nativeShare.share).not.toHaveBeenCalled();
        expect(textOf(r.toJSON())).toContain('Shared.');
    });

    it('keeps Capacitor iOS on the existing Web Share path', async () => {
        nativeShare.getPlatform.mockReturnValue('ios');
        const share = vi.fn().mockResolvedValue(undefined);
        vi.stubGlobal('navigator', { share });
        const { r, rowNamed } = render();

        await act(async () => rowNamed('Share ParQueen').props.onClick());

        expect(share).toHaveBeenCalledWith({
            title: 'ParQueen',
            text: 'Street parking, figured out. See what ParQueen can do.',
            url: 'https://parqueen.app/',
        });
        expect(nativeShare.share).not.toHaveBeenCalled();
        expect(textOf(r.toJSON())).toContain('Shared.');
    });

    it('treats closing the share menu as cancellation, not an error', async () => {
        const writeText = vi.fn();
        vi.stubGlobal('navigator', {
            share: vi.fn().mockRejectedValue(Object.assign(new Error('cancelled'), { name: 'AbortError' })),
            clipboard: { writeText },
        });
        const { r, rowNamed } = render();

        await act(async () => rowNamed('Share ParQueen').props.onClick());

        expect(writeText).not.toHaveBeenCalled();
        expect(textOf(r.toJSON())).not.toContain("Couldn't share");
        expect(r.root.findAllByProps({ href: 'https://parqueen.app/' })).toHaveLength(0);
    });

    it('copies the link when native sharing fails', async () => {
        const writeText = vi.fn().mockResolvedValue(undefined);
        vi.stubGlobal('navigator', {
            share: vi.fn().mockRejectedValue(new Error('share failed')),
            clipboard: { writeText },
        });
        const { r, rowNamed } = render();

        await act(async () => rowNamed('Share ParQueen').props.onClick());

        expect(writeText).toHaveBeenCalledWith('https://parqueen.app/');
        expect(textOf(r.toJSON())).toContain('Link copied.');
    });

    it('copies the link when native sharing is unavailable', async () => {
        const writeText = vi.fn().mockResolvedValue(undefined);
        vi.stubGlobal('navigator', { clipboard: { writeText } });
        const { r, rowNamed } = render();

        await act(async () => rowNamed('Share ParQueen').props.onClick());

        expect(writeText).toHaveBeenCalledWith('https://parqueen.app/');
        expect(textOf(r.toJSON())).toContain('Link copied.');
    });

    it('offers an accessible manual link when sharing and copying fail', async () => {
        vi.stubGlobal('navigator', {
            share: vi.fn().mockRejectedValue(new Error('share failed')),
            clipboard: { writeText: vi.fn().mockRejectedValue(new Error('copy failed')) },
        });
        const { r, rowNamed } = render();

        await act(async () => rowNamed('Share ParQueen').props.onClick());

        const link = r.root.findByProps({ href: 'https://parqueen.app/' });
        expect(link.props.target).toBe('_blank');
        expect(link.props.rel).toBe('noopener noreferrer');
        expect(textOf(r.toJSON())).toContain("Couldn't share automatically. Open or copy this link:");
    });

    it('renders the Share ParQueen row and result copy in Spanish', async () => {
        act(() => setLang('es'));
        nativeShare.getPlatform.mockReturnValue('android');
        nativeShare.share.mockResolvedValue({ activityType: 'com.example.target' });
        vi.stubGlobal('navigator', {});
        const { r, rowNamed } = render();

        await act(async () => rowNamed('Compartir ParQueen').props.onClick());

        expect(nativeShare.share).toHaveBeenCalledWith({
            title: 'ParQueen',
            text: 'Estacionamiento en la calle, resuelto. Mira lo que ParQueen puede hacer.',
            url: 'https://parqueen.app/',
            dialogTitle: 'Compartir ParQueen',
        });
        expect(textOf(r.toJSON())).toContain('Compartido.');
        expect(textOf(r.toJSON())).not.toMatch(/settings\.share_[a-z_]+/);
    });
});

describe('SettingsView — blocked users', () => {
    it('BU-01: always displays the Blocked users row', () => {
        const { rowNamed } = render();
        expect(rowNamed('Blocked users')).toBeTruthy();
        expect(rowNamed('Blocked users').props.onClick).toEqual(expect.any(Function));
    });

    it('BU-02: shows none, one, and many summaries', () => {
        expect(textOf(render().rowNamed('Blocked users'))).toContain('None');
        expect(textOf(render({ user: { blockedUsers: ['a'] } }).rowNamed('Blocked users'))).toContain('1 blocked');
        expect(textOf(render({ user: { blockedUsers: ['a', 'b', 'c'] } }).rowNamed('Blocked users'))).toContain('3 blocked');
    });

    it('BU-03: tapping the row navigates to Blocked Users', () => {
        const { rowNamed, spies } = render();
        act(() => rowNamed('Blocked users').props.onClick());
        expect(spies.setView).toHaveBeenCalledWith(AppView.BLOCKED_USERS);
    });
});

describe('SettingsView — structure and navigation', () => {
    it('has exactly one h1, named Settings', () => {
        const { r } = render();
        const h1s = r.root.findAllByType('h1');
        expect(h1s).toHaveLength(1);
        expect(textOf(h1s[0])).toBe('Settings');
    });

    it('keeps a labelled Back control that calls onBack', () => {
        const { r, spies } = render();
        act(() => r.root.findByProps({ 'aria-label': 'Back' }).props.onClick());
        expect(spies.onBack).toHaveBeenCalledTimes(1);
    });

    it('rows route to their existing destinations', () => {
        const { rowNamed, spies } = render();
        const cases: Array<[string, AppView]> = [
            ['Edit profile', AppView.EDIT_PROFILE],
            ['Notifications', AppView.NOTIFICATIONS_SETTINGS],
            ['Location', AppView.LOCATION_SETTINGS],
            ['Language', AppView.LANGUAGE_SETTINGS],
            ['Contact Us', AppView.CONTACT_US],
        ];
        for (const [label, view] of cases) {
            act(() => rowNamed(label).props.onClick());
            expect(spies.setView).toHaveBeenLastCalledWith(view);
        }
    });

    it('App Tour clears the seen flag and returns to the map', () => {
        store.set('parqueenAppTourSeen_v1', '1');
        const { rowNamed, spies } = render();
        act(() => rowNamed('App Tour').props.onClick());
        expect(store.has('parqueenAppTourSeen_v1')).toBe(false);
        expect(spies.setView).toHaveBeenCalledWith(AppView.MAP);
    });

    it('legal rows keep their same-origin destinations and open the in-app legal views', () => {
        const { r, spies } = render();
        const links = r.root.findAll(n => n.type === 'a');
        expect(links.map(a => a.props.href)).toEqual(['/privacy', '/terms']);
        for (const a of links) {
            expect(a.props.target).toBeUndefined();
        }
        act(() => links[0].props.onClick({ preventDefault: vi.fn() }));
        expect(spies.setView).toHaveBeenCalledWith(AppView.PRIVACY_POLICY);
        act(() => links[1].props.onClick({ preventDefault: vi.fn() }));
        expect(spies.setView).toHaveBeenCalledWith(AppView.TERMS_OF_USE);
    });
});

describe('SettingsView — preferences', () => {
    it('Dark theme is a real switch with name and state, and toggles', () => {
        const { r, spies } = render({ theme: 'dark' });
        const sw = r.root.findByProps({ role: 'switch', 'aria-label': 'Dark theme' });
        expect(sw.props['aria-label']).toBe('Dark theme');
        expect(sw.props['aria-checked']).toBe(true);
        act(() => sw.props.onClick());
        expect(spies.toggleTheme).toHaveBeenCalledTimes(1);
        const light = render({ theme: 'light' });
        expect(light.r.root.findByProps({ role: 'switch', 'aria-label': 'Dark theme' }).props['aria-checked']).toBe(false);
    });

    it('Notifications shows the derived status and radius when ready', () => {
        const { rowNamed } = render({ notificationRuntime: { capability: 'supported', permission: 'granted', registration: 'registered' } as any });
        expect(textOf(rowNamed('Notifications'))).toContain('On · 2 mi');
    });

    it('Notifications does not claim "On" when the browser runtime is not ready', () => {
        const { rowNamed } = render({ notificationRuntime: { capability: 'supported', permission: 'default', registration: 'idle' } as any });
        const text = textOf(rowNamed('Notifications'));
        expect(text).toContain('Not enabled');
        expect(text).not.toContain('mi');
    });

    it('Location shows the permission summary only when the app knows it', () => {
        expect(textOf(render({ permissionState: 'granted' }).rowNamed('Location'))).toContain('Allowed · Precise on');
        expect(textOf(render({ permissionState: 'denied_requestable' }).rowNamed('Location'))).toContain('Not allowed');
        expect(textOf(render({}).rowNamed('Location'))).toBe('Location');
    });

    it('Language shows the current language', () => {
        expect(textOf(render().rowNamed('Language'))).toContain('English');
    });
});

describe('SettingsView — account', () => {
    it('a verified email shows the address and a text + icon badge', () => {
        const { rowNamed } = render();
        const row = rowNamed('Email address');
        expect(textOf(row)).toContain('driver@example.com');
        const badge = row.find(n => typeof n.props.className === 'string' && n.props.className.includes('pq-badge--ok'));
        expect(textOf(badge)).toBe('Verified');
    });

    it('an unverified email says so in words', () => {
        const { rowNamed } = render({ user: { email: 'driver@example.com', emailVerified: false } });
        const badge = rowNamed('Email address').find(n => typeof n.props.className === 'string' && n.props.className.includes('pq-badge--warn'));
        expect(textOf(badge)).toBe('Unverified');
    });

    it('no email offers "Add email" and opens the existing labelled input', () => {
        const { r, rowNamed } = render({ user: {} });
        const row = rowNamed('Email address');
        expect(textOf(row)).toContain('Add email');
        act(() => row.props.onClick());
        const input = r.root.findByType('input');
        expect(input.props['aria-label']).toBe('Email address');
        expect(input.props.placeholder).toBe('you@example.com');
    });

    it('a long email truncates on one line with the full address available', () => {
        const long = 'a.really.long.email.address.for.testing.layout@subdomain.example-company.com';
        const { r } = render({ user: { email: long, emailVerified: true } });
        const email = r.root.find(n => typeof n.props.className === 'string' && n.props.className.includes('pq-settings-email'));
        expect(email.props.className).toContain('truncate');
        expect(email.props.title).toBe(long);
    });
});

describe('SettingsView — account actions', () => {
    it('Log out calls the existing logout handler directly', () => {
        const { rowNamed, spies } = render();
        act(() => rowNamed('Log out').props.onClick());
        expect(spies.onLogout).toHaveBeenCalledTimes(1);
        expect(spies.onDeleteAccount).not.toHaveBeenCalled();
    });

    it('Delete account only hands off to the existing confirmation flow', () => {
        const { rowNamed, spies } = render();
        act(() => rowNamed('Delete account').props.onClick());
        expect(spies.onDeleteAccount).toHaveBeenCalledTimes(1);
        expect(spies.onLogout).not.toHaveBeenCalled();
    });

    it('destructive and sign-out actions are styled apart from preference rows', () => {
        const { rowNamed } = render();
        expect(rowNamed('Log out').props.className).toContain('pq-signout');
        expect(rowNamed('Delete account').props.className).toContain('pq-danger-link');
        expect(rowNamed('Delete account').props.className).not.toContain('pq-settings-row');
    });
});

describe('SettingsView — localisation and theming', () => {
    it('renders Spanish without raw keys', () => {
        act(() => setLang('es'));
        const { r } = render({ permissionState: 'granted', notificationRuntime: { capability: 'supported', permission: 'granted', registration: 'registered' } as any });
        const text = textOf(r.toJSON());
        expect(text).toContain('Español');
        expect(text).not.toMatch(/\b(settings|profile|tour)\.[a-z_]+/);
    });

    it('never renders a raw translation key in English either', () => {
        const { r } = render({ permissionState: 'granted' });
        expect(textOf(r.toJSON())).not.toMatch(/\b(settings|profile|tour)\.[a-z_]+/);
    });

    it('uses the themed Settings classes (light mode is designed in CSS)', () => {
        const { r } = render();
        const classes = r.root.findAll(n => typeof n.props.className === 'string').map(n => n.props.className).join(' ');
        for (const c of ['pq-group', 'pq-settings-row', 'pq-row-icon', 'pq-switch', 'pq-plain-list', 'pq-icon-btn']) expect(classes).toContain(c);
    });
});
