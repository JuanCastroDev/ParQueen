import { describe, expect, it } from 'vitest';
import en from './en';
import es from './es';

const blockedUsersKeys = [
    'settings.blocked_users',
    'settings.blocked_users_none',
    'settings.blocked_users_one',
    'settings.blocked_users_many',
    'blocked_users.title',
    'blocked_users.back_aria',
    'blocked_users.intro',
    'blocked_users.unblock',
    'blocked_users.unblocking',
    'blocked_users.unblock_aria',
    'blocked_users.success',
    'blocked_users.error',
    'blocked_users.fallback_name',
    'blocked_users.empty_title',
    'blocked_users.empty_body',
] as const;

describe('blocked users translation parity', () => {
    it('BU-13: English and Spanish keys stay in parity', () => {
        const enKeys = Object.keys(en).filter(k => k.startsWith('blocked_users.') || k.startsWith('settings.blocked_users'));
        const esKeys = Object.keys(es).filter(k => k.startsWith('blocked_users.') || k.startsWith('settings.blocked_users'));
        expect(enKeys.sort()).toEqual([...blockedUsersKeys].sort());
        expect(esKeys.sort()).toEqual([...blockedUsersKeys].sort());
    });

    it.each(blockedUsersKeys)('%s has distinct nonempty English and Spanish copy', key => {
        expect(en[key]?.trim()).toBeTruthy();
        expect(es[key]?.trim()).toBeTruthy();
        expect(es[key]).not.toBe(en[key]);
    });
});
