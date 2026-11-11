import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Offline repository-compatibility guard for firestore.indexes.json.
//
// It compares the repository file with a pinned, sanitized production
// baseline (firestore.indexes.production-baseline.json, captured 2026-11-11
// from a read-only export whose SHA-256 is recorded in that file). It does not
// contact production and cannot detect later production drift. It only proves
// that the repository still represents the field overrides that existed in
// production on the capture date, so a `firebase deploy --only
// firestore:indexes` from this file would not propose deleting them.
//
// The production rateLimits.expiresAt TTL policy is the main reason this guard
// exists: firebase-tools lists TTL fields as field overrides, and a field
// override missing from this file is offered for deletion (and deleted under
// --force), which would remove the TTL policy.

type FieldIndex = { order?: string; arrayConfig?: string; queryScope?: string };
type FieldOverride = { collectionGroup: string; fieldPath: string; ttl?: boolean; indexes: FieldIndex[] };
type CompositeIndex = { collectionGroup: string; queryScope: string; fields: { fieldPath: string; order?: string; arrayConfig?: string }[] };
type IndexesFile = { indexes?: CompositeIndex[]; fieldOverrides?: FieldOverride[] };
type Baseline = {
    sourceSha256: string;
    capturedOn: string;
    ttlOverrides: { collectionGroup: string; fieldPath: string; ttlState: string }[];
    compositeIndexes: CompositeIndex[];
    fieldOverrides: FieldOverride[];
};

const readJson = (name: string) => JSON.parse(readFileSync(new URL(`./${name}`, import.meta.url), 'utf8'));
const key = (o: { collectionGroup: string; fieldPath: string }) => `${o.collectionGroup}.${o.fieldPath}`;
const modes = (indexes: FieldIndex[] = []) =>
    indexes.map((i) => `${i.order ?? `array:${i.arrayConfig}`}/${i.queryScope ?? 'COLLECTION'}`).sort();
const compositeKey = (c: CompositeIndex) =>
    [c.collectionGroup, c.queryScope, ...c.fields
        .filter((f) => f.fieldPath !== '__name__')
        .map((f) => `${f.fieldPath}:${f.order ?? `array:${f.arrayConfig}`}`)].join('|');

// Returns every incompatibility between the repository file and the baseline.
function baselineIncompatibilities(config: IndexesFile, baseline: Baseline): string[] {
    const errors: string[] = [];
    const overrides = Array.isArray(config.fieldOverrides) ? config.fieldOverrides : [];
    if (!Array.isArray(config.fieldOverrides)) errors.push('fieldOverrides is missing or not an array');

    const seen = new Map<string, number>();
    for (const o of overrides) seen.set(key(o), (seen.get(key(o)) ?? 0) + 1);
    for (const [k, n] of seen) if (n > 1) errors.push(`duplicate field override ${k} (${n} entries)`);

    for (const ttl of baseline.ttlOverrides) {
        const matches = overrides.filter((o) => key(o) === key(ttl));
        if (matches.length !== 1) errors.push(`expected exactly one ${key(ttl)} override, found ${matches.length}`);
        else if (matches[0].ttl !== true) errors.push(`${key(ttl)} must keep ttl: true`);
    }

    for (const expected of baseline.fieldOverrides) {
        const found = overrides.filter((o) => key(o) === key(expected));
        if (found.length === 0) {
            errors.push(`production field override ${key(expected)} is not represented`);
            continue;
        }
        for (const f of found) {
            if (expected.ttl === true && f.ttl !== true) errors.push(`${key(expected)} drops the production TTL`);
            if (expected.ttl !== true && f.ttl === true) errors.push(`${key(expected)} adds a TTL that production does not have`);
            const want = modes(expected.indexes);
            const got = modes(f.indexes);
            if (JSON.stringify(want) !== JSON.stringify(got)) {
                errors.push(`${key(expected)} indexes ${JSON.stringify(got)} differ from baseline ${JSON.stringify(want)}`);
            }
        }
    }

    const spotId = overrides.find((o) => key(o) === 'activeIncomingClaims.spotId');
    if (!spotId || !modes(spotId.indexes).includes('ASCENDING/COLLECTION_GROUP')) {
        errors.push('activeIncomingClaims.spotId must keep its ASCENDING COLLECTION_GROUP field index');
    }

    const repoComposites = new Set((config.indexes ?? []).map(compositeKey));
    for (const c of baseline.compositeIndexes) {
        if (!repoComposites.has(compositeKey(c))) errors.push(`production composite index ${compositeKey(c)} is not represented`);
    }
    return errors;
}

describe('firestore.indexes.json — compatibility with the pinned production baseline (not a live drift check)', () => {
    const config: IndexesFile = readJson('firestore.indexes.json');
    const baseline: Baseline = readJson('firestore.indexes.production-baseline.json');

    it('pins the sanitized baseline to the verified read-only export', () => {
        expect(baseline.sourceSha256).toBe('d7804d04ff4ca23bf95f0c1b1f2f248520b7577adaae162dce2e2419c9bf3c66');
        expect(baseline.capturedOn).toBe('2026-11-11');
        expect(baseline.ttlOverrides).toEqual([{ collectionGroup: 'rateLimits', fieldPath: 'expiresAt', ttlState: 'ACTIVE' }]);
        expect(baseline.compositeIndexes).toHaveLength(15);
        expect(JSON.stringify(baseline)).not.toMatch(/projects\//);
    });

    it('parses firestore.indexes.json with indexes and fieldOverrides arrays', () => {
        expect(Array.isArray(config.indexes)).toBe(true);
        expect(Array.isArray(config.fieldOverrides)).toBe(true);
    });

    it('keeps exactly one rateLimits.expiresAt override with ttl: true and the baseline index modes', () => {
        const ttl = (config.fieldOverrides ?? []).filter((o) => key(o) === 'rateLimits.expiresAt');
        expect(ttl).toHaveLength(1);
        expect(ttl[0].ttl).toBe(true);
        expect(modes(ttl[0].indexes)).toEqual(['ASCENDING/COLLECTION', 'DESCENDING/COLLECTION', 'array:CONTAINS/COLLECTION']);
    });

    it('represents every baseline field override and composite index, keeps activeIncomingClaims.spotId, and has no duplicates', () => {
        expect(baselineIncompatibilities(config, baseline)).toEqual([]);
    });

    it('fails when the TTL override is removed', () => {
        const withoutTtl: IndexesFile = {
            ...config,
            fieldOverrides: (config.fieldOverrides ?? []).filter((o) => key(o) !== 'rateLimits.expiresAt'),
        };
        expect(baselineIncompatibilities(withoutTtl, baseline)).toEqual(expect.arrayContaining([
            'expected exactly one rateLimits.expiresAt override, found 0',
            'production field override rateLimits.expiresAt is not represented',
        ]));
    });

    it('fails when ttl is turned off or a conflicting duplicate is added', () => {
        const overrides = config.fieldOverrides ?? [];
        const ttlOff: IndexesFile = {
            ...config,
            fieldOverrides: overrides.map((o) => (key(o) === 'rateLimits.expiresAt' ? { ...o, ttl: false } : o)),
        };
        expect(baselineIncompatibilities(ttlOff, baseline)).toContain('rateLimits.expiresAt must keep ttl: true');

        const duplicate: IndexesFile = {
            ...config,
            fieldOverrides: [...overrides, { collectionGroup: 'rateLimits', fieldPath: 'expiresAt', indexes: [] }],
        };
        expect(baselineIncompatibilities(duplicate, baseline)).toContain('duplicate field override rateLimits.expiresAt (2 entries)');
    });

    it('fails when activeIncomingClaims.spotId or a production override is dropped', () => {
        const overrides = config.fieldOverrides ?? [];
        const noSpotId: IndexesFile = { ...config, fieldOverrides: overrides.filter((o) => key(o) !== 'activeIncomingClaims.spotId') };
        expect(baselineIncompatibilities(noSpotId, baseline))
            .toContain('activeIncomingClaims.spotId must keep its ASCENDING COLLECTION_GROUP field index');
        const noStreetRules: IndexesFile = { ...config, fieldOverrides: overrides.filter((o) => key(o) !== 'streetRules.supersededAt') };
        expect(baselineIncompatibilities(noStreetRules, baseline))
            .toContain('production field override streetRules.supersededAt is not represented');
    });
});
