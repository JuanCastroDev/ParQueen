import type {
  CanonicalCurbResponse,
  CanonicalCurbSelector,
  SideConfirmation,
} from './canonicalCurbClient';

/**
 * QA field observations only. A high-confidence callable still follows the
 * normal server path: it upserts curbIdentities/{publicCurbKey} and
 * streetSegments/{publicCurbKey} for the curb that was just verified. It does
 * not delete any other identity. This module never reads or writes pq_saved_spot.
 */
export const QA_FIELD_TEST_TIMEOUT_MS = 45_000;

export type QaFieldRules = 'confirmed' | 'unavailable';

export interface QaFieldGps {
  sampleCount: number;
  accuracyMeters: number;
  consistencyMeters: number;
  durationMs: number;
}

export interface QaFieldReport {
  gps: QaFieldGps | null;
  firstAttemptStatus: string;
  elapsedMs: number;
  verifiedSide: string | null;
  rules: QaFieldRules | null;
  failClosedReason: string | null;
  confirmation: SideConfirmation | null;
  selector: CanonicalCurbSelector | null;
}

const finite = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

export function readQaFieldGps(raw: unknown): QaFieldGps | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  if (!finite(value.sampleCount) || !finite(value.accuracyMeters)
    || !finite(value.consistencyMeters) || !finite(value.durationMs)) return null;
  return {
    sampleCount: value.sampleCount,
    accuracyMeters: value.accuracyMeters,
    consistencyMeters: value.consistencyMeters,
    durationMs: value.durationMs,
  };
}

function rulesFor(response: CanonicalCurbResponse): QaFieldRules | null {
  if (response.status !== 'high_confidence') return null;
  return response.ruleSummary.cleaningAvailable ? 'confirmed' : 'unavailable';
}

export function reportQaCurbResponse(input: {
  response: CanonicalCurbResponse;
  gps: QaFieldGps | null;
  elapsedMs: number;
  firstAttemptStatus?: string;
}): QaFieldReport {
  const { response } = input;
  return {
    gps: input.gps,
    firstAttemptStatus: input.firstAttemptStatus ?? response.status,
    elapsedMs: input.elapsedMs,
    verifiedSide: response.status === 'high_confidence' ? response.sideLabel : null,
    rules: rulesFor(response),
    failClosedReason: response.status === 'unsupported' ? response.reason : null,
    confirmation: response.status === 'side_confirmation_required' ? response.confirmation : null,
    selector: response.status === 'ambiguous' ? response.selector : null,
  };
}

export function cancelQaCurbFieldTest(report: QaFieldReport): QaFieldReport {
  return {
    ...report,
    confirmation: null,
    selector: null,
    verifiedSide: null,
    rules: null,
    failClosedReason: 'cancelled',
  };
}

export async function runQaCurbFieldAttempt(input: {
  resolve: () => Promise<CanonicalCurbResponse>;
  readGps?: () => unknown;
  timeoutMs?: number;
  now?: () => number;
  firstAttemptStatus?: string;
}): Promise<QaFieldReport> {
  const now = input.now ?? Date.now;
  const started = now();
  const timeoutMs = input.timeoutMs ?? QA_FIELD_TEST_TIMEOUT_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const elapsed = () => Math.max(0, now() - started);
  try {
    const response = await new Promise<CanonicalCurbResponse>((resolve, reject) => {
      timer = setTimeout(() => reject(new Error('timeout')), timeoutMs);
      input.resolve().then(resolve, reject);
    });
    return reportQaCurbResponse({
      response,
      gps: readQaFieldGps(input.readGps?.() ?? null),
      elapsedMs: elapsed(),
      firstAttemptStatus: input.firstAttemptStatus,
    });
  } catch (error) {
    const timedOut = error instanceof Error && error.message === 'timeout';
    return {
      gps: readQaFieldGps(input.readGps?.() ?? null),
      firstAttemptStatus: input.firstAttemptStatus ?? 'failed',
      elapsedMs: elapsed(),
      verifiedSide: null,
      rules: null,
      failClosedReason: timedOut ? 'timeout' : 'source_unavailable',
      confirmation: null,
      selector: null,
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
}
