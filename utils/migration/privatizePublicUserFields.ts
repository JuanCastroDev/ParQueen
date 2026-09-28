/**
 * One-time migration: move privacy-sensitive fields from the public users/{uid}
 * root document into owner-only private subcollections and the userLocations collection.
 *
 * Fields moved:
 *   users/{uid} root  →  users/{uid}/private/preferences
 *     fcmToken, notificationsEnabled, notificationRadius, sharePreciseLocation, lang
 *
 *   users/{uid} root  →  users/{uid}/private/social
 *     blockedUsers
 *
 *   users/{uid} root  →  userLocations/{uid}
 *     lastGeohash, lastGeohashUpdatedAt
 *
 * Fields removed from root doc (not migrated anywhere):
 *   lastParkedLocation — only used server-side; clients no longer write it
 *
 * Run as a standalone Node script authenticated via Application Default
 * Credentials — no downloaded service-account key required:
 *   gcloud auth application-default login
 *   gcloud auth application-default set-quota-project parkqueen-46475363-ccf36
 *   npx ts-node utils/migration/privatizePublicUserFields.ts
 *
 * initializeApp({ projectId }) below passes no `credential`, so the
 * Admin SDK falls back to ADC automatically (`gcloud auth login` populates a
 * separate credential store and does NOT satisfy this — ADC must be set up
 * with the `application-default` subcommand above). Do not set
 * GOOGLE_APPLICATION_CREDENTIALS to a service-account key file.
 *
 * Flags (environment variables):
 *   DRY_RUN=true   (default) — logs actions, writes nothing
 *   DRY_RUN=false            — applies changes
 *
 * Idempotent: docs that already have none of the migrated fields are skipped.
 *
 * Rollback:
 *   - Copy fields back from private subcollections to root doc.
 *   - Copy lastGeohash/lastGeohashUpdatedAt back from userLocations/{uid} to users/{uid}.
 *   - The new Firestore rules allowlist will need to be reverted to allow client writes.
 */

import { initializeApp } from 'firebase-admin/app';
import {
    FieldValue,
    getFirestore,
    type QueryDocumentSnapshot,
} from 'firebase-admin/firestore';

const DRY_RUN = process.env.DRY_RUN !== 'false';
const PROJECT_ID = process.env.GCLOUD_PROJECT || 'parkqueen-46475363-ccf36';

initializeApp({ projectId: PROJECT_ID });
const db = getFirestore();
const FV = FieldValue;

const PREF_FIELDS = ['fcmToken', 'notificationsEnabled', 'notificationRadius', 'sharePreciseLocation', 'lang'] as const;
const SOCIAL_FIELDS = ['blockedUsers'] as const;
const LOCATION_FIELDS = ['lastGeohash', 'lastGeohashUpdatedAt'] as const;
const ALL_FIELDS = [...PREF_FIELDS, ...SOCIAL_FIELDS, ...LOCATION_FIELDS];

async function run() {
    console.log(`[privatizePublicUserFields] mode=${DRY_RUN ? 'DRY_RUN' : 'APPLY'} project=${PROJECT_ID}`);

    let cursor: QueryDocumentSnapshot | null = null;
    let processed = 0, skipped = 0, errors = 0;

    while (true) {
        const q = cursor
            ? db.collection('users').startAfter(cursor).limit(200)
            : db.collection('users').limit(200);
        const snap = await q.get();
        if (snap.empty) break;

        for (const userDoc of snap.docs) {
            const uid = userDoc.id;
            const data = userDoc.data();
            const hasAny = ALL_FIELDS.some(f => f in data);

            if (!hasAny) { skipped++; continue; }

            const maskedUid = uid.slice(0, 4) + '***';

            if (DRY_RUN) {
                const present = ALL_FIELDS.filter(f => f in data);
                console.log(`[DRY_RUN] uid=${maskedUid} would move: ${present.join(', ')}`);
                processed++;
                continue;
            }

            try {
                const prefData: Record<string, unknown> = {};
                for (const f of PREF_FIELDS) { if (f in data) prefData[f] = data[f]; }

                const socialData: Record<string, unknown> = {};
                for (const f of SOCIAL_FIELDS) { if (f in data) socialData[f] = data[f]; }

                const locData: Record<string, unknown> = {};
                for (const f of LOCATION_FIELDS) { if (f in data) locData[f] = data[f]; }

                const writes: Promise<unknown>[] = [];

                if (Object.keys(prefData).length > 0) {
                    writes.push(db.doc(`users/${uid}/private/preferences`).set(prefData, { merge: true }));
                }
                if (Object.keys(socialData).length > 0) {
                    writes.push(db.doc(`users/${uid}/private/social`).set(socialData, { merge: true }));
                }
                if (Object.keys(locData).length > 0) {
                    writes.push(db.doc(`userLocations/${uid}`).set(locData, { merge: true }));
                }

                await Promise.all(writes);

                const removeFields: Record<string, FieldValue> = {};
                for (const f of ALL_FIELDS) {
                    if (f in data) removeFields[f] = FV.delete();
                }
                // Also remove lastParkedLocation if present (no longer stored in root)
                if ('lastParkedLocation' in data) removeFields.lastParkedLocation = FV.delete();

                await userDoc.ref.update(removeFields);
                console.log(`[APPLY] uid=${maskedUid} moved: ${Object.keys(removeFields).join(', ')}`);
                processed++;
            } catch (err) {
                console.error(`[ERROR] uid=${uid.slice(0, 4)}*** — ${(err as Error).message}`);
                errors++;
            }
        }

        if (snap.size < 200) break;
        cursor = snap.docs[snap.docs.length - 1];
    }

    console.log(`\nDone. processed=${processed} skipped=${skipped} errors=${errors}`);
    if (errors > 0) process.exit(1);
}

run().catch(err => { console.error(err); process.exit(1); });
