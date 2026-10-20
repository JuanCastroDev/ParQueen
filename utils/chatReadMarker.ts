const CHAT_READ_PREFIX = 'lastReadChat_';

export function chatReadMarkerKey(userId: string, chatId: string): string {
  return `${CHAT_READ_PREFIX}${JSON.stringify([userId, chatId])}`;
}
