/**
 * Inbox visibility for an already-loaded conversation list.
 * A partner on the current user's own block list stays hidden. Removing that
 * UID from the list is what makes an existing conversation visible again.
 */
export function filterVisibleConversations<T extends { otherUser: { id: string } }>(
    conversations: T[],
    blockedUsers: string[] | undefined,
): T[] {
    const blockedList = blockedUsers || [];
    return conversations.filter(conv => !blockedList.includes(conv.otherUser.id));
}
