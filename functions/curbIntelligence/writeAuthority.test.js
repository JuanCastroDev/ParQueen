import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  WRITE_AUTHORITY_SCHEME,
  CLOCK_DRIFT_MARGIN_MS,
  generationIdFromPersistToken,
  evaluateWriteAuthority,
  associateDocumentAuthorities,
  filterAuthoritativeRules,
  segmentAllowsAuthoritativeRead,
  bindDeadlineToFirestoreClock,
} = require('./writeAuthority');

const gen = 'a'.repeat(32);

describe('write authority evaluation', () => {
  it('treats missing metadata as trusted legacy data', () => {
    expect(evaluateWriteAuthority(null)).toEqual({ status: 'legacy' });
    expect(evaluateWriteAuthority(undefined)).toEqual({ status: 'legacy' });
  });

  it('rejects malformed and inconsistent metadata', () => {
    expect(evaluateWriteAuthority({ scheme: 2, generationId: gen, deadlineAtMs: 10, committedAt: 1, promotedAt: 1 }).status).toBe('reject');
    expect(evaluateWriteAuthority({ scheme: 1, generationId: 'short', deadlineAtMs: 10, committedAt: 1, promotedAt: 1 }).status).toBe('reject');
    expect(evaluateWriteAuthority({ scheme: 1, generationId: gen, deadlineAtMs: 10, committedAt: 10, promotedAt: 1 })).toEqual({
      status: 'reject', reason: 'committed_at_or_after_deadline',
    });
    expect(evaluateWriteAuthority({ scheme: 1, generationId: gen, deadlineAtMs: 10, committedAt: 1, promotedAt: 10 })).toEqual({
      status: 'reject', reason: 'promoted_at_or_after_deadline',
    });
    expect(evaluateWriteAuthority({ scheme: 1, generationId: gen, deadlineAtMs: 10, committedAt: 1 }).status).toBe('reject');
    expect(evaluateWriteAuthority({ scheme: 1, generationId: gen, deadlineAtMs: 10, committedAt: 1 }, { role: 'staging' }).status).toBe('valid');
    expect(associateDocumentAuthorities([
      evaluateWriteAuthority({ scheme: 1, generationId: gen, deadlineAtMs: 10, committedAt: 1, promotedAt: 1 }),
      evaluateWriteAuthority(null),
    ]).reason).toBe('inconsistent_authority');
  });

  it('accepts a commit strictly before the bound deadline', () => {
    expect(evaluateWriteAuthority({
      scheme: WRITE_AUTHORITY_SCHEME,
      generationId: gen,
      deadlineAtMs: 20,
      committedAt: { toMillis: () => 18 },
      promotedAt: { toMillis: () => 19 },
    })).toMatchObject({ status: 'valid', generationId: gen, committedAtMs: 18, promotedAtMs: 19 });
  });

  it('filters rules and hashes persist tokens without exposing them', () => {
    const token = 'persist-token-secret-value';
    const generationId = generationIdFromPersistToken(token);
    expect(generationId).toMatch(/^[a-f0-9]{32}$/);
    expect(generationId).not.toContain(token);
    const segment = { writeAuthority: { scheme: 1, generationId, deadlineAtMs: 20, committedAt: 5, promotedAt: 6 } };
    const rules = [
      { id: 'keep', writeAuthority: { scheme: 1, generationId, deadlineAtMs: 20, committedAt: 5, promotedAt: 6 } },
      { id: 'late', writeAuthority: { scheme: 1, generationId, deadlineAtMs: 20, committedAt: 5, promotedAt: 20 } },
      { id: 'legacy' },
    ];
    expect(filterAuthoritativeRules(segment, rules).rules.map(rule => rule.id)).toEqual(['keep']);
    expect(segmentAllowsAuthoritativeRead({ writeAuthority: { scheme: 1, generationId, deadlineAtMs: 20, committedAt: 20 } }).ok).toBe(false);
  });

  it('binds remaining Functions budget onto a Firestore probe timestamp', async () => {
    let stored;
    const db = {
      doc() {
        return {
          async set(value) { stored = value; },
          async get() { return { exists: true, data: () => stored }; },
        };
      },
    };
    const bound = await bindDeadlineToFirestoreClock({
      db,
      FieldValue: { serverTimestamp: () => ({ toMillis: () => 1_000 }) },
      key: 'curb2_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      generationId: gen,
      deadlineAt: 5_000,
      now: () => 3_000,
    });
    expect(bound).toEqual({
      ok: true,
      deadlineFsMs: 1_000 + (5_000 - 3_000) - CLOCK_DRIFT_MARGIN_MS,
      sampledAtMs: 1_000,
      remainingMs: 2_000,
    });
  });
});