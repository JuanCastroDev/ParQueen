'use strict';

// Synthetic data only — no real export is ever used in tests.
const importer = require('./importSquarespaceWaitlist');

const NOW = Date.parse('2026-09-16T12:00:00Z');

describe('WLI — Squarespace waitlist importer', () => {
    it('WLI-1 parses quoted fields, escaped quotes, CRLF and a BOM', () => {
        const rows = importer.parseCsv('﻿Email,Name\r\n"a@example.com","Doe, ""Jo"""\r\nb@example.com,Sam\r\n\r\n');
        expect(rows).toEqual([
            ['Email', 'Name'],
            ['a@example.com', 'Doe, "Jo"'],
            ['b@example.com', 'Sam'],
        ]);
    });

    it('WLI-2 finds the email column and a signup-date column when present', () => {
        expect(importer.findColumns(['First Name', 'Email Address', 'Subscribed On']))
            .toEqual({ emailIdx: 1, dateIdx: 2 });
        expect(importer.findColumns(['Name', 'Contact email'])).toEqual({ emailIdx: 1, dateIdx: -1 });
    });

    it('WLI-3 keeps only real past dates and never invents one', () => {
        expect(importer.parseSignupDate('2025-04-02T10:00:00Z', NOW)?.toISOString()).toBe('2025-04-02T10:00:00.000Z');
        expect(importer.parseSignupDate('', NOW)).toBeNull();
        expect(importer.parseSignupDate('not a date', NOW)).toBeNull();
        expect(importer.parseSignupDate('2031-01-01T00:00:00Z', NOW)).toBeNull();
    });

    it('WLI-4 canonicalizes, drops invalid rows and merges duplicates on the earliest date', () => {
        const rows = importer.parseCsv([
            'Email,First Name,Subscribed On',
            'Driver@Example.com,Ana,2025-06-01T00:00:00Z',
            'driver@example.com ,Ana,2025-05-01T00:00:00Z',
            'not-an-email,Bo,2025-05-01T00:00:00Z',
            'other@example.com,Cy,',
        ].join('\n'));
        const { records, counts, hasDateColumn } = importer.planImport(rows, NOW);

        expect(hasDateColumn).toBe(true);
        expect(counts).toEqual({ rows: 4, invalid: 1, duplicates: 1, unique: 2, withSignupDate: 1 });
        expect(records).toEqual([
            { email: 'driver@example.com', originalSignupAt: new Date('2025-05-01T00:00:00Z') },
            { email: 'other@example.com', originalSignupAt: null },
        ]);
    });

    it('WLI-5 never carries names or other columns into a record', () => {
        const rows = importer.parseCsv('Email,First Name,Last Name,Phone\na@example.com,Ana,Diaz,555-0100\n');
        const [record] = importer.planImport(rows, NOW).records;
        expect(Object.keys(record).sort()).toEqual(['email', 'originalSignupAt']);
    });

    it('WLI-6 refuses an export without an email column', () => {
        expect(() => importer.planImport([['Name'], ['Ana']], NOW)).toThrow(/No email column/);
    });

    it('WLI-7 builds a legacy subscriber record with no confirmation and no invented date', () => {
        const FieldValue = { serverTimestamp: () => 'SERVER_TS' };
        const Timestamp = { fromDate: d => `TS(${d.toISOString()})` };
        expect(importer.importedRecord({ email: 'a@example.com', originalSignupAt: null }, { FieldValue, Timestamp }))
            .toEqual({
                email: 'a@example.com',
                status: 'subscribed',
                optInMethod: 'legacy-squarespace',
                source: 'squarespace-import',
                consentVersion: 'squarespace-legacy',
                createdAt: 'SERVER_TS',
                importedAt: 'SERVER_TS',
                confirmedAt: null,
                originalSignupAt: null,
            });
        expect(importer.importedRecord(
            { email: 'a@example.com', originalSignupAt: new Date('2025-05-01T00:00:00Z') },
            { FieldValue, Timestamp },
        ).originalSignupAt).toBe('TS(2025-05-01T00:00:00.000Z)');
    });

    it('WLI-8 is a dry run unless --write is passed', () => {
        expect(importer.parseArgs(['--file', 'x.csv'])).toEqual({ file: 'x.csv', write: false });
        expect(importer.parseArgs(['--file', 'x.csv', '--write'])).toEqual({ file: 'x.csv', write: true });
        expect(() => importer.parseArgs([])).toThrow(/Usage/);
        expect(() => importer.parseArgs(['--file', 'x.csv', '--force'])).toThrow(/Unknown argument/);
    });
});
