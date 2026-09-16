#!/usr/bin/env node
'use strict';

/**
 * One-time import of the legacy Squarespace waitlist export into waitlist/.
 *
 * DRY RUN BY DEFAULT. Nothing is written unless --write is passed.
 *
 * Usage (Windows PowerShell), Application Default Credentials:
 *   gcloud auth application-default login
 *   gcloud auth application-default set-quota-project parkqueen-46475363-ccf36
 *   $env:GCLOUD_PROJECT = "parkqueen-46475363-ccf36"
 *   $env:WAITLIST_ID_PEPPER = (gcloud secrets versions access latest --secret=WAITLIST_ID_PEPPER)
 *   cd functions
 *   node scripts/importSquarespaceWaitlist.js --file C:\path\to\squarespace-export.csv
 *   node scripts/importSquarespaceWaitlist.js --file C:\path\to\squarespace-export.csv --write
 *
 * The export is personal data. Keep the original file as the migration backup
 * OUTSIDE this repository; never commit it (see .gitignore).
 *
 * Imported records:
 *   status "subscribed", optInMethod "legacy-squarespace",
 *   source "squarespace-import", confirmedAt null.
 * These people already asked to hear when ParQueen launches, so no
 * reconfirmation email is sent. The original signup time is kept only when
 * the export actually provides one; it is never invented.
 *
 * Safety:
 * - Only the email column (and a signup-date column, if present) is read.
 *   Names and every other column are ignored and never stored.
 * - An address already in waitlist/ is never overwritten, whatever its status.
 * - Output is counts only. No address is ever printed.
 * - Sends no email.
 */

const fs = require('fs');
const { canonicalizeEmail } = require('../emailAddress');
const waitlist = require('../waitlist');

const EXPECTED_PROJECT_ID = 'parkqueen-46475363-ccf36';

// ─── Pure helpers (no Firestore) ──────────────────────────────────────────────

/** Minimal RFC 4180 CSV parser: quoted fields, escaped quotes, CRLF, BOM. */
function parseCsv(text) {
    const src = text.replace(/^\uFEFF/, '');
    const rows = [];
    let row = [];
    let field = '';
    let quoted = false;
    for (let i = 0; i < src.length; i++) {
        const ch = src[i];
        if (quoted) {
            if (ch === '"' && src[i + 1] === '"') { field += '"'; i++; }
            else if (ch === '"') quoted = false;
            else field += ch;
        } else if (ch === '"') {
            quoted = true;
        } else if (ch === ',') {
            row.push(field); field = '';
        } else if (ch === '\n' || ch === '\r') {
            if (ch === '\r' && src[i + 1] === '\n') i++;
            row.push(field); field = '';
            if (row.some(cell => cell.trim() !== '')) rows.push(row);
            row = [];
        } else {
            field += ch;
        }
    }
    row.push(field);
    if (row.some(cell => cell.trim() !== '')) rows.push(row);
    return rows;
}

const DATE_HEADERS = [
    'subscribed on', 'date subscribed', 'subscription date', 'signup date', 'sign up date',
    'submitted on', 'created on', 'date created', 'created', 'timestamp', 'date',
];

/** Finds the email column and, if one exists, a signup-date column. */
function findColumns(header) {
    const names = header.map(h => String(h || '').trim().toLowerCase());
    const exact = names.findIndex(n => n === 'email' || n === 'email address');
    const emailIdx = exact >= 0 ? exact : names.findIndex(n => n.includes('email'));
    let dateIdx = -1;
    for (const candidate of DATE_HEADERS) {
        dateIdx = names.indexOf(candidate);
        if (dateIdx >= 0) break;
    }
    return { emailIdx, dateIdx };
}

/** A real, past date from the export — or null. Never a guess. */
function parseSignupDate(value, nowMs = Date.now()) {
    const text = String(value || '').trim();
    if (!text) return null;
    const ms = Date.parse(text);
    if (!Number.isFinite(ms) || ms > nowMs) return null;
    return new Date(ms);
}

/**
 * Turns parsed CSV rows into unique, canonical import records.
 * Duplicates keep the earliest real signup date.
 */
function planImport(rows, nowMs = Date.now()) {
    if (rows.length === 0) throw new Error('The export is empty.');
    const { emailIdx, dateIdx } = findColumns(rows[0]);
    if (emailIdx < 0) throw new Error('No email column found in the export header.');

    const byEmail = new Map();
    const counts = { rows: rows.length - 1, invalid: 0, duplicates: 0, withSignupDate: 0 };

    for (const row of rows.slice(1)) {
        let email;
        try {
            email = canonicalizeEmail(row[emailIdx]);
        } catch {
            counts.invalid++;
            continue;
        }
        const signupAt = dateIdx >= 0 ? parseSignupDate(row[dateIdx], nowMs) : null;
        const existing = byEmail.get(email);
        if (existing) {
            counts.duplicates++;
            if (signupAt && (!existing.originalSignupAt || signupAt < existing.originalSignupAt)) {
                existing.originalSignupAt = signupAt;
            }
            continue;
        }
        byEmail.set(email, { email, originalSignupAt: signupAt });
    }

    const records = [...byEmail.values()];
    counts.unique = records.length;
    counts.withSignupDate = records.filter(r => r.originalSignupAt).length;
    return { records, counts, hasDateColumn: dateIdx >= 0 };
}

/** The Firestore document for one imported subscriber. */
function importedRecord({ email, originalSignupAt }, { FieldValue, Timestamp }) {
    return {
        email,
        status: waitlist.STATUS.SUBSCRIBED,
        optInMethod: waitlist.OPT_IN.LEGACY,
        source: waitlist.SOURCE.SQUARESPACE,
        consentVersion: waitlist.LEGACY_CONSENT_VERSION,
        createdAt: FieldValue.serverTimestamp(),
        importedAt: FieldValue.serverTimestamp(),
        confirmedAt: null,
        originalSignupAt: originalSignupAt ? Timestamp.fromDate(originalSignupAt) : null,
    };
}

function parseArgs(argv) {
    const args = { file: null, write: false };
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === '--write') args.write = true;
        else if (argv[i] === '--file') args.file = argv[++i];
        else throw new Error(`Unknown argument: ${argv[i]}`);
    }
    if (!args.file) throw new Error('Usage: importSquarespaceWaitlist.js --file <export.csv> [--write]');
    return args;
}

// ─── Runner ───────────────────────────────────────────────────────────────────

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const pepper = process.env.WAITLIST_ID_PEPPER;
    if (!pepper) throw new Error('WAITLIST_ID_PEPPER must be set (same value the functions use).');
    if (process.env.GCLOUD_PROJECT !== EXPECTED_PROJECT_ID) {
        throw new Error(`GCLOUD_PROJECT must be ${EXPECTED_PROJECT_ID}.`);
    }

    const { records, counts, hasDateColumn } = planImport(parseCsv(fs.readFileSync(args.file, 'utf8')));

    const admin = require('firebase-admin');
    admin.initializeApp();
    const { getFirestore, FieldValue, Timestamp } = require('firebase-admin/firestore');
    const db = getFirestore();

    let alreadyPresent = 0;
    let created = 0;
    for (const record of records) {
        const ref = db.collection(waitlist.WAITLIST_COLLECTION).doc(waitlist.waitlistDocId(record.email, pepper));
        if ((await ref.get()).exists) { alreadyPresent++; continue; }
        if (!args.write) { created++; continue; }
        try {
            // create() fails if the document appeared meanwhile — never overwrite.
            await ref.create(importedRecord(record, { FieldValue, Timestamp }));
            created++;
        } catch (error) {
            if (error?.code === 6) { alreadyPresent++; continue; } // ALREADY_EXISTS
            throw error;
        }
    }

    const mode = args.write ? 'WRITE' : 'DRY RUN (nothing written)';
    console.log(`Squarespace waitlist import — ${mode}`);
    console.log(`  rows in export:          ${counts.rows}`);
    console.log(`  invalid addresses:       ${counts.invalid}`);
    console.log(`  duplicate rows:          ${counts.duplicates}`);
    console.log(`  unique addresses:        ${counts.unique}`);
    console.log(`  signup date column:      ${hasDateColumn ? 'found' : 'none (originalSignupAt stays null)'}`);
    console.log(`  with a real signup date: ${counts.withSignupDate}`);
    console.log(`  already in waitlist:     ${alreadyPresent} (left untouched)`);
    console.log(`  ${args.write ? 'created' : 'would create'}:${' '.repeat(args.write ? 17 : 12)}${created}`);
}

if (require.main === module) {
    main().catch(error => {
        // Messages here never include addresses.
        console.error(`Import failed: ${error.message}`);
        process.exitCode = 1;
    });
}

module.exports = { parseCsv, findColumns, parseSignupDate, planImport, importedRecord, parseArgs };
