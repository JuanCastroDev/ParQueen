import { describe, expect, it } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const {
  createMemoryRuleCandidateStore,
  createSocrataSourceVersion,
  readConsistentCandidateSnapshot,
} = require('./ruleSourceAdapters');

const metadata = (resourceId = 'nfid-uabd', rowsUpdatedAt = '2026-09-15T10:04:47Z') => ({
  resourceId,
  rowsUpdatedAt,
  viewLastModified: '2026-09-15T10:00:16Z',
});

describe('Socrata rule-source identity', () => {
  it('retains only verified dataset identity and observed update metadata', () => {
    expect(createSocrataSourceVersion(metadata(), 'nfid-uabd')).toEqual({
      ok: true,
      sourceVersion: metadata(),
    });
  });

  it.each([
    [metadata('other'), 'resource_mismatch'],
    [{ resourceId: 'nfid-uabd' }, 'invalid_source_version'],
    [{ ...metadata(), rowsUpdatedAt: 'not-a-date' }, 'invalid_source_version'],
  ])('fails closed for invalid metadata %#', (input, reason) => {
    expect(createSocrataSourceVersion(input, 'nfid-uabd')).toEqual({ ok: false, reason });
  });
});

describe('bounded candidate snapshots', () => {
  it('returns COMPLETE only when coverage and result limits are complete', async () => {
    const store = createMemoryRuleCandidateStore([{ id: 'a' }, { id: 'b' }], {
      resourceId: 'nfid-uabd',
      sourceVersion: metadata(),
      coverageComplete: true,
      maxCandidates: 3,
    });
    expect(await store.queryCandidates({ matches: row => row.id === 'a' })).toEqual({
      candidates: [{ id: 'a' }],
      completeness: { state: 'COMPLETE', reason: null },
      sourceVersion: metadata(),
    });
  });

  it('marks coverage gaps and candidate truncation INCOMPLETE', async () => {
    const gap = createMemoryRuleCandidateStore([{ id: 'a' }], {
      resourceId: 'nfid-uabd', sourceVersion: metadata(), coverageComplete: false,
    });
    expect((await gap.queryCandidates({ matches: () => true })).completeness)
      .toEqual({ state: 'INCOMPLETE', reason: 'coverage_gap' });

    const capped = createMemoryRuleCandidateStore([{ id: 'a' }, { id: 'b' }], {
      resourceId: 'nfid-uabd', sourceVersion: metadata(), coverageComplete: true, maxCandidates: 1,
    });
    expect(await capped.queryCandidates({ matches: () => true })).toMatchObject({
      candidates: [{ id: 'a' }],
      completeness: { state: 'INCOMPLETE', reason: 'candidate_limit_reached' },
    });
  });

  it('rejects invalid queries instead of implying complete evidence', async () => {
    const store = createMemoryRuleCandidateStore([], {
      resourceId: 'nfid-uabd', sourceVersion: metadata(), coverageComplete: true,
    });
    expect(await store.queryCandidates({})).toMatchObject({
      candidates: [], completeness: { state: 'INCOMPLETE', reason: 'invalid_query' },
    });
  });

  it('fails a snapshot when source metadata changes during the read', async () => {
    let calls = 0;
    const source = {
      async getMetadata() { calls += 1; return metadata('nfid-uabd', calls === 1 ? '2026-09-15T10:04:47Z' : '2026-09-16T10:04:47Z'); },
      async readCandidates() { return { rows: [{ id: 'a' }], truncated: false }; },
    };
    expect(await readConsistentCandidateSnapshot(source, { resourceId: 'nfid-uabd' }))
      .toEqual({ ok: false, reason: 'source_changed_during_read' });
  });

  it('propagates an explicit incomplete state when the upstream query truncates', async () => {
    const source = {
      async getMetadata() { return metadata(); },
      async readCandidates() { return { rows: [{ id: 'a' }], truncated: true }; },
    };
    expect(await readConsistentCandidateSnapshot(source, { resourceId: 'nfid-uabd' })).toEqual({
      ok: true,
      candidates: [{ id: 'a' }],
      completeness: { state: 'INCOMPLETE', reason: 'source_query_truncated' },
      sourceVersion: metadata(),
    });
  });
});
