'use strict';

/**
 * Behavioral integration tests — deleteChat callable (server-mediated
 * conversation deletion; closes the direct-Firestore-delete gap where any
 * chat participant could delete an arbitrary individual message or the
 * whole chat document directly via the SDK).
 *
 * Strategy mirrors sendMessage.integration.test.js exactly: deleteChat has
 * enforceAppCheck:true, and the Firebase Local Emulator Suite has no App
 * Check emulator, so every test except the HTTP-boundary canary invokes the
 * exported `_deleteChatHandler` test seam directly (bypassing the App Check
 * transport gate) while still exercising the real
 * authorization/locking/recursive-deletion logic unmocked.
 *
 * Run via: npm run test:functions
 * Requires emulators: functions (5001), firestore (8080), auth (9099)
 */

const { initializeApp, getApps } = require('firebase-admin/app');
const { getFirestore, Timestamp } = require('firebase-admin/firestore');
const { getAuth } = require('firebase-admin/auth');
const fs = require('fs');
const path = require('path');

const { requireEmulatorProjectId } = require('./emulatorProjectId');
const PROJECT_ID = requireEmulatorProjectId();
const REGION = 'us-central1';
const FUNCTIONS_BASE = `http://localhost:5001/${PROJECT_ID}/${REGION}`;
const AUTH_EMULATOR = 'http://localhost:9099';
const APP_NAME = '__deleteChat_intg__';

const testApp =
    getApps().find(a => a.name === APP_NAME) ??
    initializeApp({ projectId: PROJECT_ID }, APP_NAME);
const db = getFirestore(testApp);
const adminAuth = getAuth(testApp);

let indexModule;
try {
    indexModule = require('./index.js');
} catch (e) {
    console.warn('[deleteChat.integration] Could not load index.js:', e.message);
}

// ─── Helpers ────────────────────────────────────────────────────────────

function testUid(label) {
    return `dc_${label}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
}

function testId(label) {
    return `${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function fakeRequest(uid, data = {}) {
    const NOW = Math.floor(Date.now() / 1000);
    return {
        data,
        auth: uid ? { uid, token: { uid, auth_time: NOW - 30, iat: NOW - 30, exp: NOW + 3600 } } : null,
        rawRequest: {},
    };
}

async function callDeleteChatDirect(uid, data) {
    if (!indexModule) return { error: { code: 'unavailable' } };
    try {
        return { result: await indexModule._deleteChatHandler(fakeRequest(uid, data)) };
    } catch (err) {
        return { error: { code: err.code, message: err.message } };
    }
}

async function callSendMessageDirect(uid, data) {
    if (!indexModule) return { error: { code: 'unavailable' } };
    try {
        return { result: await indexModule._sendMessageHandler(fakeRequest(uid, data)) };
    } catch (err) {
        return { error: { code: err.code, message: err.message } };
    }
}

async function createChat(chatId, participants) {
    await db.collection('chats').doc(chatId).set({
        id: chatId,
        participants,
        lastMessage: '',
        lastMessageTimestamp: Timestamp.now(),
        lastSenderId: participants[0],
    });
}

async function seedMessages(chatId, count) {
    const batch = db.batch();
    for (let i = 0; i < count; i++) {
        batch.set(db.collection('chats').doc(chatId).collection('messages').doc(testId('m')), {
            senderId: 'seed', text: `seed ${i}`, timestamp: Timestamp.now(),
        });
    }
    await batch.commit();
}

async function cleanupChat(chatId) {
    const msgs = await db.collection('chats').doc(chatId).collection('messages').get();
    await Promise.all(msgs.docs.map(d => d.ref.delete()));
    await db.collection('chats').doc(chatId).delete().catch(() => {});
}

async function deleteRateLimitCounter(uid, operation, windowSec = 3600) {
    const wk = Math.floor(Date.now() / (windowSec * 1000));
    await db.collection('rateLimits').doc(`${operation}_${wk}_${uid}`).delete().catch(() => {});
}

async function signInUser(uid) {
    try { await adminAuth.createUser({ uid }); } catch { /* already exists */ }
    const customToken = await adminAuth.createCustomToken(uid);
    const res = await fetch(
        `${AUTH_EMULATOR}/identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=fake-key`,
        {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token: customToken, returnSecureToken: true }),
        },
    );
    const body = await res.json();
    if (!body.idToken) throw new Error(`signInUser failed for ${uid}: ${JSON.stringify(body)}`);
    return body.idToken;
}

async function callFn(name, idToken, data = {}) {
    const res = await fetch(`${FUNCTIONS_BASE}/${name}`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            ...(idToken ? { Authorization: `Bearer ${idToken}` } : {}),
        },
        body: JSON.stringify({ data }),
    });
    return res.json();
}

// ─── Tests ──────────────────────────────────────────────────────────────

describe('deleteChat — server-mediated conversation deletion', () => {
    let uidA, uidB, chatId;

    beforeEach(async () => {
        uidA = testUid('a');
        uidB = testUid('b');
        chatId = testId('chat');
        await createChat(chatId, [uidA, uidB]);
    });

    afterEach(async () => {
        await cleanupChat(chatId);
        await deleteRateLimitCounter(uidA, 'deleteChat');
        await deleteRateLimitCounter(uidB, 'deleteChat');
        await deleteRateLimitCounter(uidA, 'sendMessage', 60);
        await deleteRateLimitCounter(uidB, 'sendMessage', 60);
    });

    // ─── Auth / validation ─────────────────────────────────────────────

    it('DC-01: unauthenticated request is denied with unauthenticated', async () => {
        const { error } = await callDeleteChatDirect(null, { chatId });
        expect(error.code).toBe('unauthenticated');
    });

    it('DC-02: missing chatId is rejected with invalid-argument', async () => {
        const { error } = await callDeleteChatDirect(uidA, {});
        expect(error.code).toBe('invalid-argument');
    });

    it('DC-03: a chatId containing a path-separator is rejected with invalid-argument (no path traversal)', async () => {
        const { error } = await callDeleteChatDirect(uidA, { chatId: '../../users/x' });
        expect(error.code).toBe('invalid-argument');
        // The real chat must be completely unaffected.
        expect((await db.collection('chats').doc(chatId).get()).exists).toBe(true);
    });

    it('DC-04: an existing participant is allowed to delete the chat', async () => {
        const { result, error } = await callDeleteChatDirect(uidA, { chatId });
        expect(error).toBeUndefined();
        expect(result.success).toBe(true);
        expect((await db.collection('chats').doc(chatId).get()).exists).toBe(false);
    });

    it('DC-05: a non-participant is rejected with permission-denied and the chat is untouched', async () => {
        const outsider = testUid('outsider');
        const { error } = await callDeleteChatDirect(outsider, { chatId });
        expect(error.code).toBe('permission-denied');
        expect((await db.collection('chats').doc(chatId).get()).exists).toBe(true);
        await deleteRateLimitCounter(outsider, 'deleteChat');
    });

    it('DC-06: a chat that does not exist returns idempotent success', async () => {
        const { result, error } = await callDeleteChatDirect(uidA, { chatId: testId('missing-chat') });
        expect(error).toBeUndefined();
        expect(result.success).toBe(true);
    });

    it("DC-07: Runtime-IAM canary config-contract — deleteChat's serviceAccount is the existing least-privilege parqueen-user identity (no new SA/IAM)", () => {
        const indexSrc = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');
        const callStart = indexSrc.indexOf('exports.deleteChat = onCall(');
        expect(callStart).toBeGreaterThan(-1);
        const optionsSlice = indexSrc.slice(callStart, callStart + 400);
        expect(optionsSlice).toMatch(/serviceAccount:\s*'parqueen-user@parkqueen-46475363-ccf36\.iam\.gserviceaccount\.com'/);
        expect(indexSrc).toMatch(/exports\._deleteChatHandler\s*=\s*deleteChatHandler;/);
    });

    it("DC-08a: App Check contract — enforceAppCheck:true is present in deleteChat's own options slice", () => {
        const indexSrc = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');
        const callStart = indexSrc.indexOf('exports.deleteChat = onCall(');
        expect(callStart).toBeGreaterThan(-1);
        const optionsSlice = indexSrc.slice(callStart, callStart + 400);
        expect(optionsSlice).toMatch(/enforceAppCheck:\s*true/);
    });

    it('DC-08b: App Check canary HTTP boundary — a valid auth token but no App Check token is rejected before the handler runs', async () => {
        const idToken = await signInUser(uidA);
        const resp = await callFn('deleteChat', idToken, { chatId });
        expect(resp.error?.status).toBe('UNAUTHENTICATED');
        expect(resp.result).toBeUndefined();
        expect((await db.collection('chats').doc(chatId).get()).exists).toBe(true);
        await adminAuth.deleteUser(uidA).catch(() => {});
    });

    // ─── Deletion ────────────────────────────────────────────────────────

    it('DC-09: deleting a chat removes the parent document', async () => {
        await callDeleteChatDirect(uidA, { chatId });
        expect((await db.collection('chats').doc(chatId).get()).exists).toBe(false);
    });

    it('DC-10: deleting a chat removes every message descendant', async () => {
        await seedMessages(chatId, 4);
        await callDeleteChatDirect(uidA, { chatId });
        const msgs = await db.collection('chats').doc(chatId).collection('messages').get();
        expect(msgs.empty).toBe(true);
    });

    it('DC-11: a zero-message chat deletes correctly', async () => {
        const { result, error } = await callDeleteChatDirect(uidA, { chatId });
        expect(error).toBeUndefined();
        expect(result.success).toBe(true);
        expect((await db.collection('chats').doc(chatId).get()).exists).toBe(false);
    });

    it('DC-12: a chat with multiple messages is not constrained by a single 500-write client batch (design proof, not a 500+ seed)', async () => {
        // recursiveDelete() is BulkWriter-backed (see firestore.d.ts —
        // "recursiveDelete() uses a BulkWriter instance ... to perform the
        // deletes"), not a single manual WriteBatch capped at 500 writes
        // (unlike deleteAccount's own paginatedDelete/paginatedUpdate
        // helpers, which explicitly chunk at 499 for that reason). Seeding
        // 500+ real documents here would prove nothing beyond what the SDK's
        // own documented implementation already guarantees, at a large,
        // unnecessary test-time cost — this test proves the multi-document
        // (not just single-document) deletion path instead.
        await seedMessages(chatId, 12);
        const { result, error } = await callDeleteChatDirect(uidA, { chatId });
        expect(error).toBeUndefined();
        expect(result.success).toBe(true);
        const msgs = await db.collection('chats').doc(chatId).collection('messages').get();
        expect(msgs.empty).toBe(true);
    });

    it('DC-13: retrying deleteChat after the chat is already gone succeeds idempotently', async () => {
        const first = await callDeleteChatDirect(uidA, { chatId });
        expect(first.error).toBeUndefined();
        const second = await callDeleteChatDirect(uidA, { chatId });
        expect(second.error).toBeUndefined();
        expect(second.result.success).toBe(true);
    });

    it('DC-14: two concurrent delete requests from both participants are safe — the chat ends up deleted with no thrown internal error', async () => {
        const [a, b] = await Promise.allSettled([
            indexModule._deleteChatHandler(fakeRequest(uidA, { chatId })),
            indexModule._deleteChatHandler(fakeRequest(uidB, { chatId })),
        ]);
        expect(a.status).toBe('fulfilled');
        expect(b.status).toBe('fulfilled');
        expect(a.value.success).toBe(true);
        expect(b.value.success).toBe(true);
        expect((await db.collection('chats').doc(chatId).get()).exists).toBe(false);
    });

    // ─── Send/delete race ────────────────────────────────────────────────

    it('DC-15: once the chat is marked deleting, sendMessage refuses to create a new message', async () => {
        await db.collection('chats').doc(chatId).set({ deleting: true }, { merge: true });
        const { error } = await callSendMessageDirect(uidA, { chatId, clientRequestId: testId('m'), text: 'too late' });
        expect(error).toBeDefined();
        expect(error.code).not.toBe('unavailable');
        const msgs = await db.collection('chats').doc(chatId).collection('messages').get();
        expect(msgs.empty).toBe(true);
    });

    it('DC-16 (send race): concurrent sendMessage and deleteChat never leave an orphaned message once the parent chat is gone', async () => {
        const clientRequestId = testId('m');
        await Promise.allSettled([
            callSendMessageDirect(uidA, { chatId, clientRequestId, text: 'race message' }),
            callDeleteChatDirect(uidA, { chatId }),
        ]);

        const chatSnap = await db.collection('chats').doc(chatId).get();
        const msgSnap = await db.collection('chats').doc(chatId).collection('messages').doc(clientRequestId).get();

        // The one invariant that must hold regardless of which operation
        // actually won the race in this run: the chat can never be gone
        // while a message it supposedly never received still exists.
        if (!chatSnap.exists) {
            expect(msgSnap.exists).toBe(false);
        }
    });

    it('DC-17: repeating the send/delete race many times never produces an orphaned message (statistical confidence beyond a single interleaving)', async () => {
        for (let i = 0; i < 8; i++) {
            const rChatId = testId('chat-race');
            await createChat(rChatId, [uidA, uidB]);
            const clientRequestId = testId('m');

            await Promise.allSettled([
                callSendMessageDirect(uidA, { chatId: rChatId, clientRequestId, text: `race ${i}` }),
                callDeleteChatDirect(uidA, { chatId: rChatId }),
            ]);

            const chatSnap = await db.collection('chats').doc(rChatId).get();
            const msgSnap = await db.collection('chats').doc(rChatId).collection('messages').doc(clientRequestId).get();
            if (!chatSnap.exists) {
                expect(msgSnap.exists).toBe(false);
            } else {
                await cleanupChat(rChatId);
            }
        }
    });

    // ─── Retry / partial-progress continuation ──────────────────────────

    it('DC-18: a chat already marked deleting (e.g. a prior attempt that had not yet finished sweeping messages) is fully cleaned up by a subsequent call — proves retry continuation without needing to fault-inject recursiveDelete itself (impractical against the real Admin SDK; see Phase 18 note in the PR description)', async () => {
        await seedMessages(chatId, 3);
        await db.collection('chats').doc(chatId).set({ deleting: true }, { merge: true });

        const { result, error } = await callDeleteChatDirect(uidA, { chatId });
        expect(error).toBeUndefined();
        expect(result.success).toBe(true);
        expect((await db.collection('chats').doc(chatId).get()).exists).toBe(false);
        const msgs = await db.collection('chats').doc(chatId).collection('messages').get();
        expect(msgs.empty).toBe(true);
    });
});
