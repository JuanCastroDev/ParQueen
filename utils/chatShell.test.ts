import { describe, expect, it, vi } from 'vitest';
import {
  chatIdForPair,
  chatShellCreatePayload,
  ensureChatShell,
  isExistingChatCreateCollision,
} from './chatShell';

describe('chatIdForPair', () => {
  it('is deterministic regardless of argument order', () => {
    expect(chatIdForPair('me', 'alice')).toBe('alice_me');
    expect(chatIdForPair('alice', 'me')).toBe('alice_me');
  });
});

describe('chatShellCreatePayload', () => {
  it('matches the create-only Rules schema (id, participants, relatedSpotTitle)', () => {
    expect(chatShellCreatePayload('me', 'alice', 'Spot pinged by Alice')).toEqual({
      id: 'alice_me',
      participants: ['me', 'alice'],
      relatedSpotTitle: 'Spot pinged by Alice',
    });
  });

  it('falls back to Street Spot when context is empty', () => {
    expect(chatShellCreatePayload('me', 'alice', '').relatedSpotTitle).toBe('Street Spot');
  });
});

describe('isExistingChatCreateCollision', () => {
  it('treats permission-denied as the create-once update collision', () => {
    expect(isExistingChatCreateCollision(Object.assign(new Error('Missing or insufficient permissions'), {
      code: 'permission-denied',
    }))).toBe(true);
  });

  it('treats already-exists as a concurrent-create race', () => {
    expect(isExistingChatCreateCollision(Object.assign(new Error('exists'), { code: 'already-exists' }))).toBe(true);
  });

  it('does not swallow unrelated failures', () => {
    expect(isExistingChatCreateCollision(Object.assign(new Error('offline'), { code: 'unavailable' }))).toBe(false);
    expect(isExistingChatCreateCollision(new Error('boom'))).toBe(false);
    expect(isExistingChatCreateCollision('permission-denied')).toBe(false);
  });
});

describe('ensureChatShell', () => {
  const payload = chatShellCreatePayload('me', 'alice', 'Street Spot');

  it('creates a brand-new chat without probing existence', async () => {
    const create = vi.fn(async () => {});
    await expect(ensureChatShell(create, payload)).resolves.toBe('created');
    expect(create).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledWith(payload);
  });

  it('treats a create-once update denial as already-exists (re-open / concurrent init)', async () => {
    const create = vi.fn(async () => {
      throw Object.assign(new Error('Missing or insufficient permissions'), { code: 'permission-denied' });
    });
    await expect(ensureChatShell(create, payload)).resolves.toBe('already-exists');
  });

  it('rethrows unexpected create failures so the caller does not attach a messages listener', async () => {
    const err = Object.assign(new Error('offline'), { code: 'unavailable' });
    const create = vi.fn(async () => { throw err; });
    await expect(ensureChatShell(create, payload)).rejects.toBe(err);
  });

  it('is safe if both participants initialize at once: first create wins, second collides', async () => {
    let created = false;
    const create = vi.fn(async () => {
      if (!created) {
        created = true;
        return;
      }
      throw Object.assign(new Error('Missing or insufficient permissions'), { code: 'permission-denied' });
    });
    await expect(ensureChatShell(create, payload)).resolves.toBe('created');
    await expect(ensureChatShell(create, payload)).resolves.toBe('already-exists');
    expect(create).toHaveBeenCalledTimes(2);
  });

  it('does not probe when create succeeds', async () => {
    const create = vi.fn(async () => {});
    const shellExists = vi.fn(async () => true);
    await expect(ensureChatShell(create, payload, shellExists)).resolves.toBe('created');
    expect(shellExists).not.toHaveBeenCalled();
  });

  it('treats a collision as already-exists only when the shell is readable', async () => {
    const create = vi.fn(async () => {
      throw Object.assign(new Error('Missing or insufficient permissions'), { code: 'permission-denied' });
    });
    const shellExists = vi.fn(async () => true);
    await expect(ensureChatShell(create, payload, shellExists)).resolves.toBe('already-exists');
    expect(shellExists).toHaveBeenCalledTimes(1);
  });

  it('rethrows a create denial when the shell is not readable (mutual block or other create refusal)', async () => {
    const err = Object.assign(new Error('Missing or insufficient permissions'), { code: 'permission-denied' });
    const create = vi.fn(async () => { throw err; });
    const shellExists = vi.fn(async () => false);
    await expect(ensureChatShell(create, payload, shellExists)).rejects.toBe(err);
  });

  it('rethrows a create denial when the readability probe is itself permission-denied', async () => {
    const err = Object.assign(new Error('Missing or insufficient permissions'), { code: 'firestore/permission-denied' });
    const create = vi.fn(async () => { throw err; });
    const shellExists = vi.fn(async () => {
      throw Object.assign(new Error('Missing or insufficient permissions'), { code: 'permission-denied' });
    });
    await expect(ensureChatShell(create, payload, shellExists)).rejects.toBe(err);
  });
});
