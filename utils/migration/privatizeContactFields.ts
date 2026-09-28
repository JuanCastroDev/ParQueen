/**
 * One-time migration: move `phone` and `email` from the public users/{uid}
 * document into the owner-only users/{uid}/private/account subcollection.
 *
 * Run as a standalone Node script authenticated via Application Default
 * Credentials — no downloaded service-account key required:
 *   gcloud auth application-default login
 *   gcloud auth application-default set-quota-project parkqueen-46475363-ccf36
 *   npx ts-node utils/migration/privatizeContactFields.ts
 *
 * initializeApp({ projectId }) below passes no `credential`, so the
 * Admin SDK falls back to ADC automatically (`gcloud auth login` populates a
 * separate credential store and does NOT satisfy this — ADC must be set up
 * with the `application-default` subcommand above). Do not set
 * GOOGLE_APPLICATION_CREDENTIALS to a service-account key file.
 *
 * Flags (set via environment variables):
 *   DRY_RUN=true   (default) — logs actions, writes nothing
 *   DRY_RUN=false            — applies changes
 *
 * Idempotent: docs that already have neither field are skipped.
 *
 * Rollback:
 *   - To restore email to the public doc: copy from users/{uid}/private/account
 *     back to users/{uid} and delete the private account doc.
 *   - Phone is no longer stored in Firestore; it is available from
 *     Firebase Auth (user.phoneNumber) and does not need to be rolled back.
 */

import { initializeApp } from 'firebase-admin/app';
import { FieldValue, getFirestore } from 'firebase-admin/firestore';

const DRY_RUN = process.env.DRY_RUN !== 'false';
const PROJECT_ID = process.env.GCLOUD_PROJECT || 'parkqueen-46475363-ccf36';

initializeApp({ projectId: PROJECT_ID });
const db = getFirestore();

function maskValue(value: string): string {
  if (!value) return '(empty)';
  return value.slice(0, 2) + '***';
}

async function run() {
  console.log(`[privatizeContactFields] mode=${DRY_RUN ? 'DRY_RUN' : 'APPLY'} project=${PROJECT_ID}`);

  const usersSnap = await db.collection('users').get();
  let processed = 0, skipped = 0, errors = 0;

  for (const userDoc of usersSnap.docs) {
    const uid = userDoc.id;
    const data = userDoc.data();
    const hasPhone = 'phone' in data;
    const hasEmail = 'email' in data;

    if (!hasPhone && !hasEmail) {
      skipped++;
      continue;
    }

    const logParts = [`uid=${uid.slice(0, 4)}***`];
    if (hasPhone) logParts.push(`phone=${maskValue(data.phone)}`);
    if (hasEmail) logParts.push(`email=${maskValue(data.email)}`);

    if (DRY_RUN) {
      console.log(`[DRY_RUN] would migrate ${logParts.join(' ')}`);
      processed++;
      continue;
    }

    try {
      const privateRef = db.doc(`users/${uid}/private/account`);
      if (hasEmail) {
        await privateRef.set({ email: data.email }, { merge: true });
      }
      const removeFields: Record<string, FieldValue> = {};
      if (hasPhone) removeFields.phone = FieldValue.delete();
      if (hasEmail) removeFields.email = FieldValue.delete();
      await userDoc.ref.update(removeFields);
      console.log(`[APPLY] migrated ${logParts.join(' ')}`);
      processed++;
    } catch (err) {
      console.error(`[ERROR] uid=${uid.slice(0, 4)}*** — ${(err as Error).message}`);
      errors++;
    }
  }

  console.log(`\nDone. processed=${processed} skipped=${skipped} errors=${errors}`);
  if (errors > 0) process.exit(1);
}

run().catch(err => { console.error(err); process.exit(1); });
