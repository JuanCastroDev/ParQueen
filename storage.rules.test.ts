/**
 * Firebase Storage Security Rules tests — ParQueen quarantine avatar architecture.
 *
 * Phase H quarantine design:
 *   avatarUploads/{uid}/{uploadId}/{file}  — client upload (owner write only)
 *   avatarCandidates/{**}                  — server-only (no client access)
 *   avatars/{uid}                           — server-published (owner read only)
 *
 * Run via:
 *   npm run test:storage:rules          (starts emulator automatically)
 *   npm run test:storage:rules:unit     (assumes emulator already on :9199)
 */
import { readFileSync } from 'node:fs';
import { describe, it, beforeAll, afterAll, expect } from 'vitest';
import {
    initializeTestEnvironment,
    assertFails,
    assertSucceeds,
    type RulesTestEnvironment,
} from '@firebase/rules-unit-testing';
import { ref, uploadBytes, getBytes, deleteObject } from 'firebase/storage';
import { doc, setDoc } from 'firebase/firestore';

const OWNER_UID  = 'owner-st-111';
const OTHER_UID  = 'other-st-222';
const UPLOAD_ID  = 'upload-abc123';
const PROJECT_ID = 'demo-parkqueen-storage-test';

// Tiny valid image payloads
const JPEG_DATA = new Uint8Array([0xFF, 0xD8, 0xFF, 0xE0, ...new Uint8Array(1020)]);
const PNG_DATA  = new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, ...new Uint8Array(1016)]);
const IMAGE_META = { contentType: 'image/jpeg' };

let testEnv: RulesTestEnvironment;

beforeAll(async () => {
    testEnv = await initializeTestEnvironment({
        projectId: PROJECT_ID,
        firestore: {
            rules: readFileSync('firestore.rules', 'utf8'),
            host: '127.0.0.1',
            port: 8080,
        },
        storage: {
            rules: readFileSync('storage.rules', 'utf8'),
            host: '127.0.0.1',
            port: 9199,
        },
    });
});

afterAll(async () => {
    await testEnv.cleanup();
});

// ── Helpers ────────────────────────────────────────────────────────────────────

function ownerStorage() { return testEnv.authenticatedContext(OWNER_UID).storage(); }
function otherStorage() { return testEnv.authenticatedContext(OTHER_UID).storage(); }
function anonStorage()  { return testEnv.unauthenticatedContext().storage(); }

function uploadPath(uid = OWNER_UID, uploadId = UPLOAD_ID) {
    return `avatarUploads/${uid}/${uploadId}/original`;
}

// ── avatarUploads/ — client write rules ───────────────────────────────────────

describe('ST-01 – ST-09, ST-23: avatarUploads/ write rules', () => {
    // Each test uses a unique uploadId so the operation is a CREATE, not an UPDATE.
    // The rules use `allow create` (no overwrites); writing to an existing path fails.

    it('ST-01: owner can upload JPEG to their upload quarantine path', async () => {
        await assertSucceeds(
            uploadBytes(ref(ownerStorage(), uploadPath(OWNER_UID, 'st01-jpeg')), JPEG_DATA, IMAGE_META),
        );
    });

    it('ST-02: owner can upload PNG to their upload quarantine path', async () => {
        await assertSucceeds(
            uploadBytes(ref(ownerStorage(), uploadPath(OWNER_UID, 'st02-png')), PNG_DATA, { contentType: 'image/png' }),
        );
    });

    it('ST-03: owner can upload WebP to their upload quarantine path', async () => {
        await assertSucceeds(
            uploadBytes(ref(ownerStorage(), uploadPath(OWNER_UID, 'st03-webp')), JPEG_DATA, { contentType: 'image/webp' }),
        );
    });

    it('ST-04: non-owner cannot upload to another user\'s upload path', async () => {
        await assertFails(
            uploadBytes(ref(otherStorage(), uploadPath(OWNER_UID)), JPEG_DATA, IMAGE_META),
        );
    });

    it('ST-05: unauthenticated cannot upload to any upload path', async () => {
        await assertFails(
            uploadBytes(ref(anonStorage(), uploadPath()), JPEG_DATA, IMAGE_META),
        );
    });

    it('ST-06: SVG (image/svg+xml) is rejected — not in MIME allowlist', async () => {
        await assertFails(
            uploadBytes(ref(ownerStorage(), uploadPath()), JPEG_DATA, { contentType: 'image/svg+xml' }),
        );
    });

    it('ST-07: GIF (image/gif) is rejected — not in allowlist', async () => {
        await assertFails(
            uploadBytes(ref(ownerStorage(), uploadPath()), JPEG_DATA, { contentType: 'image/gif' }),
        );
    });

    it('ST-08: application/pdf is rejected — not in allowlist', async () => {
        await assertFails(
            uploadBytes(ref(ownerStorage(), uploadPath()), new Uint8Array(512), { contentType: 'application/pdf' }),
        );
    });

    it('ST-09: upload > 5 MB is rejected', async () => {
        const oversized = new Uint8Array(5 * 1024 * 1024 + 1);
        await assertFails(
            uploadBytes(ref(ownerStorage(), uploadPath()), oversized, IMAGE_META),
        );
    });

    // Regression coverage for the production 403: uploadBytes(ref, file) called
    // with no metadata argument leaves Content-Type to fall back to
    // application/octet-stream (or blank), which the rule correctly rejects.
    // The fix is client-side (utils/avatarUploadValidation.ts passes an explicit,
    // verified contentType) — this test guards the rule side of that contract.
    it('ST-23: blank/application/octet-stream contentType is rejected — not in allowlist', async () => {
        await assertFails(
            uploadBytes(ref(ownerStorage(), uploadPath()), JPEG_DATA, { contentType: 'application/octet-stream' }),
        );
    });
});

// ── avatarUploads/ — client read and delete denied ────────────────────────────

describe('ST-10 – ST-12: avatarUploads/ read/delete is server-only', () => {
    beforeAll(async () => {
        // Pre-seed a file bypassing rules so read/delete tests have something to check
        await testEnv.withSecurityRulesDisabled(async ctx => {
            await uploadBytes(ref(ctx.storage(), uploadPath()), JPEG_DATA, IMAGE_META);
        });
    });

    it('ST-10: owner cannot read (getBytes) their own upload path', async () => {
        await assertFails(getBytes(ref(ownerStorage(), uploadPath())));
    });

    it('ST-11: owner cannot delete their own upload path', async () => {
        await assertFails(deleteObject(ref(ownerStorage(), uploadPath())));
    });

    it('ST-12: other user cannot read upload path at all', async () => {
        await assertFails(getBytes(ref(otherStorage(), uploadPath(OWNER_UID))));
    });
});

// ── avatarCandidates/ — fully server-only ────────────────────────────────────

describe('ST-13 – ST-15: avatarCandidates/ is server-only (no client access)', () => {
    const candidatePath = `avatarCandidates/${OWNER_UID}/${UPLOAD_ID}.webp`;

    beforeAll(async () => {
        await testEnv.withSecurityRulesDisabled(async ctx => {
            await uploadBytes(ref(ctx.storage(), candidatePath), JPEG_DATA, { contentType: 'image/webp' });
        });
    });

    it('ST-13: owner cannot read a candidate file', async () => {
        await assertFails(getBytes(ref(ownerStorage(), candidatePath)));
    });

    it('ST-14: owner cannot write to avatarCandidates/', async () => {
        await assertFails(
            uploadBytes(ref(ownerStorage(), candidatePath), JPEG_DATA, { contentType: 'image/webp' }),
        );
    });

    it('ST-15: unauthenticated cannot read a candidate file', async () => {
        await assertFails(getBytes(ref(anonStorage(), candidatePath)));
    });
});

// ── avatars/ — server-published, owner-read, no client write ─────────────────

describe('ST-16 – ST-20: avatars/ published path rules', () => {
    const publishedPath = `avatars/${OWNER_UID}`;

    beforeAll(async () => {
        await testEnv.withSecurityRulesDisabled(async ctx => {
            await uploadBytes(ref(ctx.storage(), publishedPath), JPEG_DATA, IMAGE_META);
        });
    });

    it('ST-16: owner can read their published avatar', async () => {
        await assertSucceeds(getBytes(ref(ownerStorage(), publishedPath)));
    });

    it('ST-17: non-owner cannot read another user\'s published avatar', async () => {
        await assertFails(getBytes(ref(otherStorage(), publishedPath)));
    });

    it('ST-18: unauthenticated cannot read any published avatar', async () => {
        await assertFails(getBytes(ref(anonStorage(), publishedPath)));
    });

    it('ST-19: owner cannot write to published avatar path (server-only)', async () => {
        await assertFails(
            uploadBytes(ref(ownerStorage(), publishedPath), JPEG_DATA, IMAGE_META),
        );
    });

    it('ST-20: owner cannot delete their published avatar (server-only)', async () => {
        await assertFails(deleteObject(ref(ownerStorage(), publishedPath)));
    });
});

// ── Catch-all deny ─────────────────────────────────────────────────────────────

describe('ST-21 – ST-22: catch-all deny for paths outside avatar families', () => {
    it('ST-21: authenticated user cannot write to an arbitrary path', async () => {
        await assertFails(
            uploadBytes(ref(ownerStorage(), `users/${OWNER_UID}/data`), JPEG_DATA, IMAGE_META),
        );
    });

    it('ST-22: authenticated user cannot read an arbitrary path', async () => {
        await assertFails(getBytes(ref(ownerStorage(), 'private/secret')));
    });
});

// ── AV: Upload abuse controls ─────────────────────────────────────────────────
// Storage Rules enforce: owner-only, MIME allowlist, 5 MB cap, create-only,
// and the upload-time access gate (one users/{uid} document).
// pendingUploadId match and requestedAt freshness stay in moderateAvatarUpload.
// private/access is not read.

describe('AV-01 – AV-06: upload abuse controls', () => {
    const AV_UID      = 'av-owner-777';
    const AV_OTHER    = 'av-other-888';
    const AV_UPLOAD_A = 'av-upload-aaa';
    const AV_UPLOAD_B = 'av-upload-bbb';

    function avOwnerStorage() { return testEnv.authenticatedContext(AV_UID).storage(); }
    function avOtherStorage() { return testEnv.authenticatedContext(AV_OTHER).storage(); }
    function avAnonStorage()  { return testEnv.unauthenticatedContext().storage(); }

    // AV-01: owner can create a valid upload (create-only path)
    it('AV-01: owner can create their upload at /original', async () => {
        await assertSucceeds(
            uploadBytes(
                ref(avOwnerStorage(), `avatarUploads/${AV_UID}/${AV_UPLOAD_A}/original`),
                JPEG_DATA, IMAGE_META,
            ),
        );
    });

    // AV-02: PARTIAL — production Rules text verified by AV-07; staging overwrite smoke
    // test required before go-live. The emulator cannot distinguish create vs update.
    //
    // Staging smoke test procedure (do NOT run against production):
    //   1. Upload a valid original to avatarUploads/{uid}/{uploadId}/original.
    //   2. Attempt a second write to the exact same path (same uid, same uploadId).
    //   3. Confirm the second write is denied (PERMISSION_DENIED / HTTP 403).
    //   4. Confirm a write to a different uploadId succeeds (new create is allowed).
    //   5. Confirm a cross-user write to the same uid path is denied.
    it.skip('AV-02: PARTIAL — overwrite denied by allow update:if false (staging smoke test required)', async () => {
        await assertFails(
            uploadBytes(
                ref(avOwnerStorage(), `avatarUploads/${AV_UID}/${AV_UPLOAD_A}/original`),
                PNG_DATA, { contentType: 'image/png' },
            ),
        );
    });

    // AV-03: non-"original" filename is denied under upload quarantine
    it('AV-03: non-"original" filename in upload quarantine is denied', async () => {
        await assertFails(
            uploadBytes(
                ref(avOwnerStorage(), `avatarUploads/${AV_UID}/${AV_UPLOAD_B}/metadata`),
                JPEG_DATA, IMAGE_META,
            ),
        );
    });

    // AV-04: cross-user upload denied (wrong uid in path)
    it('AV-04: another user cannot upload to a different user\'s upload path', async () => {
        await assertFails(
            uploadBytes(
                ref(avOtherStorage(), `avatarUploads/${AV_UID}/av-other-attempt/original`),
                JPEG_DATA, IMAGE_META,
            ),
        );
    });

    // AV-05: unauthenticated cannot upload to any path
    it('AV-05: unauthenticated cannot upload to upload quarantine', async () => {
        await assertFails(
            uploadBytes(
                ref(avAnonStorage(), `avatarUploads/${AV_UID}/av-anon-attempt/original`),
                JPEG_DATA, IMAGE_META,
            ),
        );
    });

    // AV-06: valid upload with fresh uploadId is allowed (distinct from AV-01)
    it('AV-06: owner can create a second upload with a new unique uploadId', async () => {
        await assertSucceeds(
            uploadBytes(
                ref(avOwnerStorage(), `avatarUploads/${AV_UID}/${AV_UPLOAD_B}/original`),
                PNG_DATA, { contentType: 'image/png' },
            ),
        );
    });
});

// ── AV-07: Static Rules text assertion ────────────────────────────────────────
// AV-02 is skipped because the emulator cannot distinguish create vs update.
// This non-emulator test verifies the rule text itself is correct so that
// production Firebase Storage will enforce the update prohibition.

describe('AV-07: storage.rules static text assertion — update prohibition in exact match block', () => {
    it('AV-07: exact /avatarUploads/.../original block allows create and denies update/delete/read', () => {
        const rules = readFileSync('storage.rules', 'utf8');
        // Isolate the exact block — guards against comments or unrelated blocks satisfying the check.
        const matchIdx = rules.indexOf('match /avatarUploads/{uid}/{uploadId}/original');
        expect(matchIdx).toBeGreaterThan(-1);
        // Skip past the match path to the body-opening brace.
        // {uid}/{uploadId} in the path are NOT block delimiters — start counting after /original.
        const pathEnd  = rules.indexOf('/original', matchIdx) + '/original'.length;
        const bodyOpen = rules.indexOf('{', pathEnd);
        let depth = 0, blockEnd = bodyOpen;
        for (let i = bodyOpen; i < rules.length; i++) {
            if (rules[i] === '{') depth++;
            else if (rules[i] === '}') { depth--; if (depth === 0) { blockEnd = i + 1; break; } }
        }
        const block = rules.slice(bodyOpen, blockEnd);
        // Must allow create (owner + MIME/size guard).
        expect(block).toMatch(/allow\s+create\s*:/);
        // Must deny update. Combined "allow update, delete, read: if false" covers it.
        expect(block).toMatch(/allow\s+update[^:]*:\s*if\s+false/);
        // No allow line in this block may grant update, delete, or read.
        const allowLines = block.split('\n').map((l: string) => l.trim()).filter((l: string) => l.startsWith('allow'));
        for (const line of allowLines) {
            if (/update|delete|read/.test(line)) {
                expect(line).toContain('if false');
            }
        }
    });
});

// Upload create reads users/{uid} only. Published avatar reads stay owner-only.
describe('S7 access — Storage upload gate', () => {
    async function seedProfile(uid: string, profile: object) {
        await testEnv.withSecurityRulesDisabled(async (ctx) => {
            await setDoc(doc(ctx.firestore(), 'users', uid), profile);
        });
    }

    function storageFor(uid: string) {
        return testEnv.authenticatedContext(uid).storage();
    }

    it('A: a user with no profile and no access doc can upload', async () => {
        const uid = 's7-st-legacy';
        await assertSucceeds(
            uploadBytes(ref(storageFor(uid), uploadPath(uid, 's7-a')), JPEG_DATA, IMAGE_META),
        );
    });

    it('B: Suspended denies a new upload even when productAccessBlocked is false', async () => {
        const uid = 's7-st-susp';
        await seedProfile(uid, { status: 'Suspended', productAccessBlocked: false });
        await assertFails(
            uploadBytes(ref(storageFor(uid), uploadPath(uid, 's7-b')), JPEG_DATA, IMAGE_META),
        );
    });

    it('C: productAccessBlocked true denies a new upload while public status is Active', async () => {
        const uid = 's7-st-blocked';
        await seedProfile(uid, { status: 'Active', productAccessBlocked: true });
        await assertFails(
            uploadBytes(ref(storageFor(uid), uploadPath(uid, 's7-c')), JPEG_DATA, IMAGE_META),
        );
    });

    it('D: the same auth context is denied after productAccessBlocked becomes true', async () => {
        const uid = 's7-st-token';
        const storage = storageFor(uid);
        await seedProfile(uid, { status: 'Active', productAccessBlocked: false });
        await assertSucceeds(
            uploadBytes(ref(storage, uploadPath(uid, 's7-d1')), JPEG_DATA, IMAGE_META),
        );
        await seedProfile(uid, { status: 'Active', productAccessBlocked: true });
        await assertFails(
            uploadBytes(ref(storage, uploadPath(uid, 's7-d2')), JPEG_DATA, IMAGE_META),
        );
    });

    it('I: a malformed productAccessBlocked fails closed, and boolean false does not', async () => {
        const uid = 's7-st-malformed';
        const bad = ['false', 1, null];
        for (const [index, productAccessBlocked] of bad.entries()) {
            await seedProfile(uid, { status: 'Active', productAccessBlocked });
            await assertFails(
                uploadBytes(ref(storageFor(uid), uploadPath(uid, `s7-i-${index}`)), JPEG_DATA, IMAGE_META),
            );
        }
        await seedProfile(uid, { status: 'Active', productAccessBlocked: false });
        await assertSucceeds(
            uploadBytes(ref(storageFor(uid), uploadPath(uid, 's7-i-ok')), JPEG_DATA, IMAGE_META),
        );
        await seedProfile(uid, { status: 'Suspended', productAccessBlocked: false });
        await assertFails(
            uploadBytes(ref(storageFor(uid), uploadPath(uid, 's7-i-susp')), JPEG_DATA, IMAGE_META),
        );
    });

    it('published avatar read stays available to a Suspended owner', async () => {
        const uid = 's7-st-published';
        const publishedPath = `avatars/${uid}`;
        await seedProfile(uid, { status: 'Suspended', productAccessBlocked: true });
        await testEnv.withSecurityRulesDisabled(async (ctx) => {
            await uploadBytes(ref(ctx.storage(), publishedPath), JPEG_DATA, IMAGE_META);
        });
        await assertSucceeds(getBytes(ref(storageFor(uid), publishedPath)));
        await assertFails(
            uploadBytes(ref(storageFor(uid), uploadPath(uid, 's7-pub')), JPEG_DATA, IMAGE_META),
        );
    });
});
