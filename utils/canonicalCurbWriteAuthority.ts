/**
 * Client-side eligibility for persisted canonical curb writes.
 * Mirrors functions/curbIntelligence/writeAuthority.js.
 *
 * A stored result is authoritative only when writeAuthority is absent
 * (trusted pre-contract legacy data) or when every used document shares
 * the same valid generation whose Firestore-resolved committedAt AND
 * promotedAt are both strictly earlier than deadlineAtMs. Clients compare
 * stored server fields only; they do not use the device clock.
 * New-scheme publications live in streetSegmentsV2 / streetRulesV2 so
 * older clients that query streetSegments / streetRules cannot consume
 * unverified generations.
 */
export const WRITE_AUTHORITY_SCHEME = 1;
export const PUBLIC_SEGMENT_COLLECTION = 'streetSegmentsV2';
export const PUBLIC_RULES_SUBCOLLECTION = 'streetRulesV2';
export const LEGACY_SEGMENT_COLLECTION = 'streetSegments';
export const LEGACY_RULES_SUBCOLLECTION = 'streetRules';
const GENERATION_ID_PATTERN = /^[a-f0-9]{32}$/;

export type WriteAuthorityEvaluation =
  | { status: 'legacy' }
  | { status: 'valid'; generationId: string; committedAtMs: number; deadlineAtMs: number; promotedAtMs?: number }
  | { status: 'reject'; reason: string };

export type WriteAuthorityRecord = {
  scheme?: unknown;
  generationId?: unknown;
  deadlineAtMs?: unknown;
  committedAt?: unknown;
  promotedAt?: unknown;
};

export type EvaluateWriteAuthorityOptions = {
  role?: 'staging' | 'public';
};

function timestampToMillis(value: unknown): number | null {
  if (value == null) return null;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'object' && value && 'toMillis' in value && typeof (value as { toMillis: () => number }).toMillis === 'function') {
    try {
      const ms = (value as { toMillis: () => number }).toMillis();
      return Number.isFinite(ms) ? ms : null;
    } catch {
      return null;
    }
  }
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isFinite(ms) ? ms : null;
  }
  if (typeof value === 'object' && value && 'seconds' in value && typeof (value as { seconds: unknown }).seconds === 'number') {
    const seconds = (value as { seconds: number; nanoseconds?: number }).seconds;
    const nanos = (value as { nanoseconds?: number }).nanoseconds || 0;
    return seconds * 1000 + Math.floor(nanos / 1e6);
  }
  return null;
}

export function evaluateWriteAuthority(
  authority: WriteAuthorityRecord | null | undefined,
  options: EvaluateWriteAuthorityOptions = {},
): WriteAuthorityEvaluation {
  if (authority == null) return { status: 'legacy' };
  if (typeof authority !== 'object') return { status: 'reject', reason: 'malformed_authority' };
  if (authority.scheme !== WRITE_AUTHORITY_SCHEME) {
    return { status: 'reject', reason: 'malformed_authority' };
  }
  if (typeof authority.generationId !== 'string' || !GENERATION_ID_PATTERN.test(authority.generationId)) {
    return { status: 'reject', reason: 'malformed_authority' };
  }
  if (typeof authority.deadlineAtMs !== 'number' || !Number.isFinite(authority.deadlineAtMs)) {
    return { status: 'reject', reason: 'malformed_authority' };
  }
  const committedAtMs = timestampToMillis(authority.committedAt);
  if (committedAtMs == null) return { status: 'reject', reason: 'malformed_authority' };
  if (committedAtMs >= authority.deadlineAtMs) {
    return { status: 'reject', reason: 'committed_at_or_after_deadline' };
  }
  if (options.role === 'staging') {
    return {
      status: 'valid',
      generationId: authority.generationId,
      committedAtMs,
      deadlineAtMs: authority.deadlineAtMs,
    };
  }
  const promotedAtMs = timestampToMillis(authority.promotedAt);
  if (promotedAtMs == null) return { status: 'reject', reason: 'malformed_authority' };
  if (promotedAtMs >= authority.deadlineAtMs) {
    return { status: 'reject', reason: 'promoted_at_or_after_deadline' };
  }
  return {
    status: 'valid',
    generationId: authority.generationId,
    committedAtMs,
    promotedAtMs,
    deadlineAtMs: authority.deadlineAtMs,
  };
}

export function filterAuthoritativeRules<T extends object>(
  segment: ({ writeAuthority?: WriteAuthorityRecord | null } & object) | null | undefined,
  rules: readonly T[] | null | undefined,
): { ok: boolean; rules: T[]; reason: string | null; status: 'legacy' | 'valid' | 'reject' } {
  const segmentEval = evaluateWriteAuthority((segment as { writeAuthority?: WriteAuthorityRecord | null } | null | undefined)?.writeAuthority);
  if (segmentEval.status === 'reject') {
    return { ok: false, rules: [], reason: segmentEval.reason, status: 'reject' };
  }
  const list = Array.isArray(rules) ? rules : [];
  const kept: T[] = [];
  for (const rule of list) {
    const ruleEval = evaluateWriteAuthority((rule as { writeAuthority?: WriteAuthorityRecord | null }).writeAuthority);
    if (segmentEval.status === 'legacy') {
      if (ruleEval.status === 'legacy') kept.push(rule);
      continue;
    }
    if (ruleEval.status === 'valid' && 'generationId' in segmentEval && ruleEval.generationId === segmentEval.generationId) {
      kept.push(rule);
    }
  }
  return {
    ok: true,
    rules: kept,
    reason: null,
    status: segmentEval.status,
  };
}

export function segmentAllowsAuthoritativeRead(
  segment: { writeAuthority?: WriteAuthorityRecord | null } | null | undefined,
): { ok: boolean; reason: string | null } {
  const evaluation = evaluateWriteAuthority(segment?.writeAuthority);
  if (evaluation.status === 'reject') return { ok: false, reason: evaluation.reason };
  return { ok: true, reason: null };
}