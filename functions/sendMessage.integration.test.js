'use strict';

/**
 * Behavioral integration tests — sendMessage callable (authoritative chat
 * message write path; closes the direct-Firestore-write moderation bypass
 * documented in the dead-callable audit).
 *
 * Strategy mirrors adminReadViews.integration.test.js's Stage 4A approach:
 * sendMessage has enforceAppCheck:true, and the Firebase Local Emulator
 * Suite has no App Check emulator, so every test except the one HTTP-
 * boundary test (SM-20b) invokes the exported `_sendMessageHandler` test
 * seam directly (bypassing the App Check transport gate) while still
 * exercising the real chat-authorization/moderation/rate-limit/write logic
 * unmocked. `request.auth` is a plain fabricated object (no real Auth
 * emulator round-trip needed) because, unlike adminReadView's
 * requireCurrentAdmin, sendMessage never calls getAuth() — it only reads
 * request.auth.uid from the already-verified callable token, matching
 * moderateContent/claimUsername's existing pattern. Only SM-20b needs a
 * real Auth-emulator-issued ID token, since the HTTP transport layer (not
 * the handler) verifies it.
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
const APP_NAME = '__sendMessage_intg__';

const testApp =
    getApps().find(a => a.name === APP_NAME) ??
    initializeApp({ projectId: PROJECT_ID }, APP_NAME);
const db = getFirestore(testApp);
const adminAuth = getAuth(testApp);

let indexModule;
try {
    indexModule = require('./index.js');
} catch (e) {
    console.warn('[sendMessage.integration] Could not load index.js:', e.message);
}

// ─── Helpers ────────────────────────────────────────────────────────────

function testUid(label) {
    return `sm_${label}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
}

function testId(label) {
    return `${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Fabricates a CallableRequest with auth claims — sendMessage never calls
 * getAuth(), so no real Auth emulator round-trip is needed here. */
function fakeRequest(uid, data = {}) {
    const NOW = Math.floor(Date.now() / 1000);
    return {
        data,
        auth: uid ? { uid, token: { uid, auth_time: NOW - 30, iat: NOW - 30, exp: NOW + 3600 } } : null,
        rawRequest: {},
    };
}

/** Calls _sendMessageHandler directly and normalizes a thrown HttpsError into { error }. */
async function callDirect(uid, data) {
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
        participantNames: {},
        lastMessage: '',
        lastMessageTimestamp: Timestamp.now(),
        lastSenderId: participants[0],
    });
}

async function cleanupChat(chatId) {
    const msgs = await db.collection('chats').doc(chatId).collection('messages').get();
    await Promise.all(msgs.docs.map(d => d.ref.delete()));
    await db.collection('chats').doc(chatId).delete().catch(() => {});
}

async function deleteRateLimitCounter(uid) {
    const wk = Math.floor(Date.now() / (60 * 1000));
    await db.collection('rateLimits').doc(`sendMessage_${wk}_${uid}`).delete().catch(() => {});
}

async function seedRateLimitCounter(uid, count) {
    const wk = Math.floor(Date.now() / (60 * 1000));
    const docId = `sendMessage_${wk}_${uid}`;
    await db.collection('rateLimits').doc(docId).set({
        count, uid, operation: 'sendMessage',
        expiresAt: Timestamp.fromMillis(Date.now() + 120 * 1000),
    });
    return docId;
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

describe('sendMessage — authoritative chat message write path', () => {
    let uidA, uidB, chatId;

    beforeEach(async () => {
        uidA = testUid('a');
        uidB = testUid('b');
        chatId = testId('chat');
        await createChat(chatId, [uidA, uidB]);
    });

    afterEach(async () => {
        await cleanupChat(chatId);
        await deleteRateLimitCounter(uidA);
        await deleteRateLimitCounter(uidB);
    });

    it('SM-01: unauthenticated request is denied with unauthenticated', async () => {
        const { error } = await callDirect(null, { chatId, clientRequestId: testId('m'), text: 'hi' });
        expect(error.code).toBe('unauthenticated');
    });

    it('SM-02: malformed request (missing chatId) is rejected with invalid-argument', async () => {
        const { error } = await callDirect(uidA, { clientRequestId: testId('m'), text: 'hi' });
        expect(error.code).toBe('invalid-argument');
    });

    it('SM-03: empty/whitespace-only text is rejected with invalid-argument', async () => {
        const { error } = await callDirect(uidA, { chatId, clientRequestId: testId('m'), text: '   ' });
        expect(error.code).toBe('invalid-argument');
    });

    it('SM-04: text over 1000 characters is rejected with invalid-argument', async () => {
        const { error } = await callDirect(uidA, { chatId, clientRequestId: testId('m'), text: 'a'.repeat(1001) });
        expect(error.code).toBe('invalid-argument');
    });

    it('SM-05: a non-participant is rejected with permission-denied', async () => {
        const outsider = testUid('outsider');
        const { error } = await callDirect(outsider, { chatId, clientRequestId: testId('m'), text: 'hi' });
        expect(error.code).toBe('permission-denied');
        await deleteRateLimitCounter(outsider);
    });

    it('SM-06: a nonexistent chat is rejected with not-found', async () => {
        const { error } = await callDirect(uidA, { chatId: testId('missing-chat'), clientRequestId: testId('m'), text: 'hi' });
        expect(error.code).toBe('not-found');
    });

    it('SM-07: sender identity comes from auth, never a client-supplied senderId', async () => {
        const clientRequestId = testId('m');
        const { result, error } = await callDirect(uidA, {
            chatId, clientRequestId, text: 'hello',
            senderId: 'attacker-supplied-uid',
        });
        expect(error).toBeUndefined();
        const doc = await db.collection('chats').doc(chatId).collection('messages').doc(clientRequestId).get();
        expect(doc.data().senderId).toBe(uidA);
        expect(doc.data().senderId).not.toBe('attacker-supplied-uid');
        expect(result.id).toBe(clientRequestId);
    });

    it('SM-08: a valid message from a participant is accepted', async () => {
        const clientRequestId = testId('m');
        const { result, error } = await callDirect(uidA, { chatId, clientRequestId, text: 'hello there' });
        expect(error).toBeUndefined();
        expect(result.success).toBe(true);
        expect(result.id).toBe(clientRequestId);
        const doc = await db.collection('chats').doc(chatId).collection('messages').doc(clientRequestId).get();
        expect(doc.exists).toBe(true);
        expect(doc.data().text).toBe('hello there');
    });

    it('SM-09: banned-word content is rejected server-side with invalid-argument', async () => {
        const { error } = await callDirect(uidA, { chatId, clientRequestId: testId('m'), text: 'this is shit' });
        expect(error.code).toBe('invalid-argument');
    });

    it('SM-10: a hate/violence-category BANNED_WORDS entry is rejected server-side (breadth beyond generic profanity)', async () => {
        const { error } = await callDirect(uidA, { chatId, clientRequestId: testId('m'), text: 'there is a bomb' });
        expect(error.code).toBe('invalid-argument');
    });

    it('SM-11: an off-platform-solicitation/contact-info pattern is rejected server-side', async () => {
        const { error } = await callDirect(uidA, { chatId, clientRequestId: testId('m'), text: 'text me at 555-123-4567' });
        expect(error.code).toBe('invalid-argument');
    });

    it('SM-12: unexpected fields cannot alter the stored schema', async () => {
        const clientRequestId = testId('m');
        const { error } = await callDirect(uidA, {
            chatId, clientRequestId, text: 'hi',
            senderId: 'nope', timestamp: 'not-a-real-timestamp', extraField: 'should be ignored',
        });
        expect(error).toBeUndefined();
        const doc = await db.collection('chats').doc(chatId).collection('messages').doc(clientRequestId).get();
        expect(Object.keys(doc.data()).sort()).toEqual(['senderId', 'text', 'timestamp']);
    });

    it('SM-13: the stored timestamp is server-derived, never the client-supplied value', async () => {
        const clientRequestId = testId('m');
        const before = Date.now();
        const { error } = await callDirect(uidA, { chatId, clientRequestId, text: 'hi', timestamp: 'bogus' });
        expect(error).toBeUndefined();
        const doc = await db.collection('chats').doc(chatId).collection('messages').doc(clientRequestId).get();
        const ts = doc.data().timestamp;
        expect(ts).toBeInstanceOf(Timestamp);
        expect(ts.toMillis()).toBeGreaterThanOrEqual(before - 1000);
        expect(ts.toMillis()).toBeLessThanOrEqual(Date.now() + 1000);
    });

    it('SM-14: a duplicate clientRequestId is idempotent — no duplicate document, chat metadata not re-touched', async () => {
        const clientRequestId = testId('m');
        const first = await callDirect(uidA, { chatId, clientRequestId, text: 'first text' });
        expect(first.error).toBeUndefined();
        const second = await callDirect(uidA, { chatId, clientRequestId, text: 'a different second text' });
        expect(second.error).toBeUndefined();
        expect(second.result.id).toBe(first.result.id);

        const msgsSnap = await db.collection('chats').doc(chatId).collection('messages').get();
        expect(msgsSnap.size).toBe(1);
        expect(msgsSnap.docs[0].data().text).toBe('first text');

        const chatSnap = await db.collection('chats').doc(chatId).get();
        expect(chatSnap.data().lastMessage).toBe('first text'); // not overwritten by the retried second call
    });

    it('SM-15: the rate limit is enforced (30/60s) before the write', async () => {
        await seedRateLimitCounter(uidA, 30);
        const { error } = await callDirect(uidA, { chatId, clientRequestId: testId('m'), text: 'hi' });
        expect(error.code).toBe('resource-exhausted');
    });

    it('SM-16: a valid request writes exactly the expected message schema', async () => {
        const clientRequestId = testId('m');
        await callDirect(uidA, { chatId, clientRequestId, text: 'schema check' });
        const doc = await db.collection('chats').doc(chatId).collection('messages').doc(clientRequestId).get();
        const data = doc.data();
        expect(Object.keys(data).sort()).toEqual(['senderId', 'text', 'timestamp']);
        expect(data.senderId).toBe(uidA);
        expect(data.text).toBe('schema check');
        expect(data.timestamp).toBeInstanceOf(Timestamp);
    });

    it('SM-17: a rejected (banned-content) message creates no message document', async () => {
        const clientRequestId = testId('m');
        const { error } = await callDirect(uidA, { chatId, clientRequestId, text: 'this is shit' });
        expect(error.code).toBe('invalid-argument');
        const doc = await db.collection('chats').doc(chatId).collection('messages').doc(clientRequestId).get();
        expect(doc.exists).toBe(false);
    });

    it('SM-18: a rejected (banned-content) message performs no downstream chat-metadata mutation', async () => {
        const before = (await db.collection('chats').doc(chatId).get()).data();
        const { error } = await callDirect(uidA, { chatId, clientRequestId: testId('m'), text: 'this is shit' });
        expect(error.code).toBe('invalid-argument');
        const after = (await db.collection('chats').doc(chatId).get()).data();
        expect(after.lastMessage).toBe(before.lastMessage);
        expect(after.lastSenderId).toBe(before.lastSenderId);
    });

    // ─── Chat metadata hardening (chats/{chatId} authoritative fields) ────

    it('CM-03: chats/{chatId}.lastMessage equals the exact stored, already-approved message text', async () => {
        const clientRequestId = testId('m');
        await callDirect(uidA, { chatId, clientRequestId, text: 'preview parity check' });
        const msgDoc = await db.collection('chats').doc(chatId).collection('messages').doc(clientRequestId).get();
        const chatDoc = await db.collection('chats').doc(chatId).get();
        expect(chatDoc.data().lastMessage).toBe(msgDoc.data().text);
    });

    it('CM-04: chats/{chatId}.lastSenderId is authoritative — a client-supplied lastSenderId in the request is ignored', async () => {
        const clientRequestId = testId('m');
        await callDirect(uidA, { chatId, clientRequestId, text: 'hi', lastSenderId: 'attacker-supplied-uid' });
        const chatDoc = await db.collection('chats').doc(chatId).get();
        expect(chatDoc.data().lastSenderId).toBe(uidA);
        expect(chatDoc.data().lastSenderId).not.toBe('attacker-supplied-uid');
    });

    it('CM-05: chats/{chatId}.lastMessageTimestamp is server-derived, never a client-supplied value', async () => {
        const clientRequestId = testId('m');
        const before = Date.now();
        await callDirect(uidA, { chatId, clientRequestId, text: 'hi', lastMessageTimestamp: 'bogus' });
        const chatDoc = await db.collection('chats').doc(chatId).get();
        const ts = chatDoc.data().lastMessageTimestamp;
        expect(ts).toBeInstanceOf(Timestamp);
        expect(ts.toMillis()).toBeGreaterThanOrEqual(before - 1000);
        expect(ts.toMillis()).toBeLessThanOrEqual(Date.now() + 1000);
    });

    it('CM-08: a non-participant sender changes neither the message nor chat metadata', async () => {
        const outsider = testUid('cm-outsider');
        const before = (await db.collection('chats').doc(chatId).get()).data();
        const { error } = await callDirect(outsider, { chatId, clientRequestId: testId('m'), text: 'hi' });
        expect(error.code).toBe('permission-denied');
        const after = (await db.collection('chats').doc(chatId).get()).data();
        expect(after.lastMessage).toBe(before.lastMessage);
        expect(after.lastSenderId).toBe(before.lastSenderId);
        await deleteRateLimitCounter(outsider);
    });

    it('CM-09: a rate-limited send changes neither the message nor chat metadata', async () => {
        await seedRateLimitCounter(uidA, 30);
        const before = (await db.collection('chats').doc(chatId).get()).data();
        const clientRequestId = testId('m');
        const { error } = await callDirect(uidA, { chatId, clientRequestId, text: 'hi' });
        expect(error.code).toBe('resource-exhausted');
        const after = (await db.collection('chats').doc(chatId).get()).data();
        expect(after.lastMessage).toBe(before.lastMessage);
        const msgDoc = await db.collection('chats').doc(chatId).collection('messages').doc(clientRequestId).get();
        expect(msgDoc.exists).toBe(false);
    });

    it("SM-19: Runtime-IAM canary config-contract — sendMessage's serviceAccount is the dedicated parqueen-user identity; test seam is nondeployable", () => {
        const indexSrc = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');
        const callStart = indexSrc.indexOf('exports.sendMessage = onCall(');
        expect(callStart).toBeGreaterThan(-1);
        const optionsSlice = indexSrc.slice(callStart, callStart + 600);
        expect(optionsSlice).toMatch(/serviceAccount:\s*'parqueen-user@parkqueen-46475363-ccf36\.iam\.gserviceaccount\.com'/);

        // exports._sendMessageHandler is a bare function export (not onCall-
        // wrapped) — same convention as _adminReadViewHandler; confirmed not
        // scanned as a deployable Cloud Function by the emulator's own
        // "Loaded functions definitions from source" discovery log.
        expect(indexSrc).toMatch(/exports\._sendMessageHandler\s*=\s*sendMessageHandler;/);
    });

    it("SM-20a: App Check contract — enforceAppCheck:true is present in sendMessage's own options slice", () => {
        const indexSrc = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');
        const callStart = indexSrc.indexOf('exports.sendMessage = onCall(');
        expect(callStart).toBeGreaterThan(-1);
        const optionsSlice = indexSrc.slice(callStart, callStart + 600);
        expect(optionsSlice).toMatch(/enforceAppCheck:\s*true/);
        expect(optionsSlice).not.toMatch(/consumeAppCheckToken/);
    });

    it('SM-21: a chat marked deleting (server-mediated deletion in progress) refuses a new message and performs no write', async () => {
        await db.collection('chats').doc(chatId).set({ deleting: true }, { merge: true });
        const clientRequestId = testId('m');
        const { error } = await callDirect(uidA, { chatId, clientRequestId, text: 'too late' });
        expect(error).toBeDefined();
        const doc = await db.collection('chats').doc(chatId).collection('messages').doc(clientRequestId).get();
        expect(doc.exists).toBe(false);
    });

    it('SM-20b: App Check canary HTTP boundary — a valid auth token but no App Check token is rejected before the handler runs', async () => {
        const idToken = await signInUser(uidA);
        // Raw HTTP call (not callDirect): the onCall wrapper's
        // enforceAppCheck:true gate only exists at the transport layer —
        // a real, valid, current auth token is not enough by itself.
        const resp = await callFn('sendMessage', idToken, { chatId, clientRequestId: testId('m'), text: 'hi' });
        expect(resp.error?.status).toBe('UNAUTHENTICATED');
        expect(resp.result).toBeUndefined();
        // Confirm the transport rejection really did stop before any write.
        const msgsSnap = await db.collection('chats').doc(chatId).collection('messages').get();
        expect(msgsSnap.empty).toBe(true);
        await adminAuth.deleteUser(uidA).catch(() => {});
    });
});
