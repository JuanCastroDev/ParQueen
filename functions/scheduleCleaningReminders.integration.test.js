'use strict';

/**
 * F7 / R3 — scheduleCleaningReminders (real handler, Firestore emulator).
 * Inverts QA's F7-R3 poison-doc reproduction: with malformed docs present the
 * job resolves, legit reminders are delivered, and malformed docs are
 * quarantined. Recipient is always the session owner's private/preferences
 * token; the session doc's fcmToken is ignored. Push sends are captured via
 * _pingNotificationHooks.send (no FCM network calls).
 */

const { initializeApp, getApps } = require('firebase-admin/app');
const { getFirestore, Timestamp } = require('firebase-admin/firestore');

const { requireEmulatorProjectId } = require('./emulatorProjectId');
const PROJECT_ID = requireEmulatorProjectId();
const APP_NAME = '__schedule_cleaning_reminders_intg__';
const testApp = getApps().find((a) => a.name === APP_NAME) ?? initializeApp({ projectId: PROJECT_ID }, APP_NAME);
const db = getFirestore(testApp);
const indexModule = require('./index.js');

const RUN = `${process.pid}_${Date.now()}`;
let seq = 0;
const uid = (label) => `scr_${label}_${RUN}_${++seq}`;
const SUMMARY_RE = /^cleaningReminders: due=\d+ sent=\d+ failed=\d+ skippedNoToken=\d+ invalid=\d+$/;

const DUE = () => Timestamp.fromMillis(Date.now() - 60_000);
const LATER = () => Timestamp.fromMillis(Date.now() + 60 * 60_000);

function session(owner, overrides = {}) {
    return {
        userId: owner,
        fcmToken: `doc-token-${owner}`,
        streetName: 'Broadway',
        nextCleaningAt: LATER(),
        reminderAt: DUE(),
        reminderMinutesBefore: 60,
        reminderEnabled: true,
        reminderSent: false,
        active: true,
        savedAt: Timestamp.now(),
        ...overrides,
    };
}

async function seedOwner(owner, token = `prefs-token-${owner}`) {
    if (token !== null) await db.doc(`users/${owner}/private/preferences`).set({ fcmToken: token });
}

async function clearSessions() {
    const snap = await db.collection('parkingSessions').get();
    await Promise.all(snap.docs.map((d) => d.ref.delete()));
}

let sent;
let logs;
let origLog;

beforeEach(async () => {
    await clearSessions();
    sent = [];
    indexModule._pingNotificationHooks.send = async (push) => { sent.push(push); return 'mid'; };
    logs = [];
    origLog = console.log;
    console.log = (...a) => { logs.push(a.map(String).join(' ')); };
});

afterEach(() => {
    console.log = origLog;
    indexModule._pingNotificationHooks.send = null;
});

const summaries = () => logs.filter((l) => l.startsWith('cleaningReminders:'));
const run = () => indexModule.scheduleCleaningReminders.run({});

describe('F7 — recipient binding (no caller-selected recipient)', () => {
    it('SCR-01: sends to the owner private/preferences token and ignores the session doc fcmToken', async () => {
        const a = uid('a');
        await seedOwner(a);
        await db.doc(`parkingSessions/${a}`).set(session(a, { fcmToken: 'victim-device-token' }));
        await run();
        expect(sent).toHaveLength(1);
        expect(sent[0].token).toBe(`prefs-token-${a}`);
        expect(JSON.stringify(sent)).not.toContain('victim-device-token');
        expect((await db.doc(`parkingSessions/${a}`).get()).data().reminderSent).toBe(true);
    });

    it('SCR-02: a userId field naming another user does not redirect delivery (doc id is the owner)', async () => {
        const a = uid('a');
        const victim = uid('victim');
        await seedOwner(a);
        await seedOwner(victim);
        await db.doc(`parkingSessions/${a}`).set(session(a, { userId: victim }));
        await run();
        expect(sent.map((p) => p.token)).toEqual([`prefs-token-${a}`]);
    });

    it('SCR-03: owner without a private token is skipped (no send), counted as skippedNoToken, marked sent', async () => {
        const a = uid('notoken');
        await db.doc(`parkingSessions/${a}`).set(session(a));
        await run();
        expect(sent).toHaveLength(0);
        expect(summaries()[0]).toMatch(/skippedNoToken=1/);
        expect((await db.doc(`parkingSessions/${a}`).get()).data().reminderSent).toBe(true);
    });
});

describe('F7 / R3 — poison-doc isolation', () => {
    it('SCR-10: poison reminderAt values (string, map, number, bool, array) no longer abort the run; legit reminder IS sent', async () => {
        const good = uid('good');
        await seedOwner(good);
        await db.doc(`parkingSessions/${good}`).set(session(good));
        const poison = ['x', { seconds: 1 }, 12345, true, [1]];
        const poisonIds = [];
        for (const value of poison) {
            const p = uid('poison');
            poisonIds.push(p);
            await seedOwner(p);
            await db.doc(`parkingSessions/${p}`).set(session(p, { reminderAt: value }));
        }
        await run(); // must resolve (previously threw TypeError)
        expect(sent.map((x) => x.token)).toEqual([`prefs-token-${good}`]);
        expect(summaries()).toHaveLength(1);
        expect(summaries()[0]).toMatch(/invalid=5/);
        for (const p of poisonIds) {
            const d = (await db.doc(`parkingSessions/${p}`).get()).data();
            expect(d.reminderEnabled).toBe(false); // quarantined: stops matching the query
            expect(d.reminderAt).toBeNull();        // poison value cleared → doc is rules-valid again
        }
        sent = [];
        logs = [];
        await run(); // second run: poison docs no longer selected
        expect(sent).toHaveLength(0);
        expect(summaries()[0]).toBe('cleaningReminders: due=0 sent=0 failed=0 skippedNoToken=0 invalid=0');
    });

    it('SCR-11: one FCM send failure is isolated; the other reminder is still delivered and both are marked sent', async () => {
        const bad = uid('sendfail');
        const good = uid('good');
        await seedOwner(bad, 'fail-me');
        await seedOwner(good);
        await db.doc(`parkingSessions/${bad}`).set(session(bad));
        await db.doc(`parkingSessions/${good}`).set(session(good));
        indexModule._pingNotificationHooks.send = async (push) => {
            if (push.token === 'fail-me') throw new Error('messaging/registration-token-not-registered');
            sent.push(push);
            return 'mid';
        };
        const errs = [];
        const origErr = console.error;
        console.error = (...a) => { errs.push(a.map(String).join(' ')); };
        try { await run(); } finally { console.error = origErr; }
        expect(sent.map((p) => p.token)).toEqual([`prefs-token-${good}`]);
        expect(summaries()[0]).toMatch(/due=2 sent=1 failed=1/);
        expect((await db.doc(`parkingSessions/${bad}`).get()).data().reminderSent).toBe(true);
        expect(errs.join('\n')).not.toContain(bad);
    });

    it('SCR-12: a reminderSent update failure (doc deleted mid-run) is isolated and the job still resolves', async () => {
        const gone = uid('gone');
        const good = uid('good');
        await seedOwner(gone);
        await seedOwner(good);
        await db.doc(`parkingSessions/${gone}`).set(session(gone));
        await db.doc(`parkingSessions/${good}`).set(session(good));
        indexModule._pingNotificationHooks.send = async (push) => {
            sent.push(push);
            if (push.token === `prefs-token-${gone}`) await db.doc(`parkingSessions/${gone}`).delete();
            return 'mid';
        };
        const origErr = console.error;
        console.error = () => {};
        try { await run(); } finally { console.error = origErr; }
        expect(sent).toHaveLength(2);
        expect(summaries()[0]).toMatch(/failed=1/);
        expect((await db.doc(`parkingSessions/${good}`).get()).data().reminderSent).toBe(true);
    });

    it('SCR-13: null reminderAt (deactivate merge) and future reminderAt are untouched and not counted invalid', async () => {
        const n = uid('null');
        const f = uid('future');
        await seedOwner(n);
        await seedOwner(f);
        await db.doc(`parkingSessions/${n}`).set(session(n, { reminderAt: null }));
        await db.doc(`parkingSessions/${f}`).set(session(f, { reminderAt: LATER() }));
        await run();
        expect(sent).toHaveLength(0);
        expect(summaries()[0]).toBe('cleaningReminders: due=0 sent=0 failed=0 skippedNoToken=0 invalid=0');
        expect((await db.doc(`parkingSessions/${n}`).get()).data().reminderEnabled).toBe(true);
        expect((await db.doc(`parkingSessions/${f}`).get()).data().reminderSent).toBe(false);
    });
});

describe('F7 — display text bounding', () => {
    it('SCR-20: streetName is sanitized and truncated; reminderMinutesBefore is coerced', async () => {
        const a = uid('long');
        await seedOwner(a);
        await db.doc(`parkingSessions/${a}`).set(session(a, {
            streetName: '<b>Visit\nevil.example</b> ' + 'x'.repeat(300),
            reminderMinutesBefore: 'soon',
        }));
        await run();
        expect(sent).toHaveLength(1);
        const body = sent[0].notification.body;
        expect(body).not.toMatch(/[<>\n]/);
        expect(body).toContain('starts in 60 minutes');
        const street = body.replace(/^Street cleaning on /, '').replace(/ starts in 60 minutes$/, '');
        expect(street.length).toBeLessThanOrEqual(80);
    });

    it('SCR-21: missing or non-string streetName falls back to a generic body', async () => {
        const a = uid('nostreet');
        await seedOwner(a);
        await db.doc(`parkingSessions/${a}`).set(session(a, { streetName: { evil: true } }));
        await run();
        expect(sent[0].notification.body).toBe('Street cleaning starts in 60 minutes');
    });

    it('SCR-22: sanitizer unit cases', () => {
        const s = indexModule._sanitizeReminderStreetName;
        expect(s('  W  42 St ')).toBe('W 42 St');
        expect(s('')).toBeNull();
        expect(s(null)).toBeNull();
        expect(s('a'.repeat(200)).length).toBe(80);
    });
});

describe('F7 — observability summary', () => {
    it('SCR-30: exactly one value-free summary per run — no UIDs, tokens, or street names', async () => {
        const a = uid('obs');
        await seedOwner(a, 'secret-token-value');
        await db.doc(`parkingSessions/${a}`).set(session(a, { streetName: 'Secret Street' }));
        await run();
        expect(summaries()).toHaveLength(1);
        expect(summaries()[0]).toMatch(SUMMARY_RE);
        expect(summaries()[0]).toBe('cleaningReminders: due=1 sent=1 failed=0 skippedNoToken=0 invalid=0');
        const all = logs.join('\n');
        expect(all).not.toContain(a);
        expect(all).not.toContain('secret-token-value');
        expect(all).not.toContain('Secret Street');
    });

    it('SCR-31: an empty run still emits one all-zero summary', async () => {
        await run();
        expect(summaries()).toEqual(['cleaningReminders: due=0 sent=0 failed=0 skippedNoToken=0 invalid=0']);
    });
});
