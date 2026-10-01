export function blockedUsersSummary(
    count: number,
): { key: string; params?: { count: number } } {
    if (count <= 0) return { key: 'settings.blocked_users_none' };
    if (count === 1) return { key: 'settings.blocked_users_one' };
    return { key: 'settings.blocked_users_many', params: { count } };
}
