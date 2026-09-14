/**
 * Create-once chat shell helpers.
 *
 * chats/{chatId} is participant-readable only (`allow read: if
 * chatParticipant(resource.data)`). A getDoc/onSnapshot existence probe of a
 * deterministic NEW chat fails with permission-denied because resource.data
 * does not exist yet — the client must never read a missing parent to decide
 * whether to create it.
 *
 * Create is allowed for a signed-in participant with the shell schema
 * (id/participants/relatedSpotTitle). Update is denied unconditionally, so
 * setDoc of an already-existing shell collides as permission-denied. That
 * collision is the idempotent "already exists" signal when two participants
 * initialize at once, or when the same user re-opens an existing thread.
 */

export interface ChatShellCreatePayload {
  id: string;
  participants: string[];
  relatedSpotTitle: string;
}

export type ChatShellOutcome = 'created' | 'already-exists';

export function chatIdForPair(uidA: string, uidB: string): string {
  return [uidA, uidB].sort().join('_');
}

export function chatShellCreatePayload(
  uidA: string,
  uidB: string,
  relatedSpotTitle: string,
): ChatShellCreatePayload {
  return {
    id: chatIdForPair(uidA, uidB),
    participants: [uidA, uidB],
    relatedSpotTitle: relatedSpotTitle || 'Street Spot',
  };
}

function errorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

/**
 * setDoc against an existing create-once chat is an update, which Rules
 * deny. Treat only that (and a genuine already-exists) as a benign race —
 * never a malformed create, network failure, or unauthenticated write.
 */
export function isExistingChatCreateCollision(error: unknown): boolean {
  const code = errorCode(error);
  if (!code) return false;
  const bare = code.startsWith('firestore/') ? code.slice('firestore/'.length) : code;
  return bare === 'permission-denied' || bare === 'already-exists';
}

export async function ensureChatShell(
  create: (payload: ChatShellCreatePayload) => Promise<void>,
  payload: ChatShellCreatePayload,
): Promise<ChatShellOutcome> {
  try {
    await create(payload);
    return 'created';
  } catch (error) {
    if (isExistingChatCreateCollision(error)) return 'already-exists';
    throw error;
  }
}
