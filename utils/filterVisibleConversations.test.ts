import { describe, expect, it } from 'vitest';
import { filterVisibleConversations } from './filterVisibleConversations';

const chat = (id: string) => ({ id, otherUser: { id } });

describe('filterVisibleConversations', () => {
    it('BU-14: a blocked conversation remains hidden while blocked', () => {
        const list = [chat('partner'), chat('friend')];
        expect(filterVisibleConversations(list, ['partner']).map(c => c.id)).toEqual(['friend']);
    });

    it('BU-15: removing the partner UID makes the existing conversation visible again', () => {
        const list = [chat('partner'), chat('friend')];
        expect(filterVisibleConversations(list, []).map(c => c.id)).toEqual(['partner', 'friend']);
        expect(filterVisibleConversations(list, undefined).map(c => c.id)).toEqual(['partner', 'friend']);
    });
});
