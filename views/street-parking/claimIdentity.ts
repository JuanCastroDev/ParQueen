export const CLAIM_GENERATION_ID_RE = /^[0-9a-f]{64}$/;
export const CLAIM_ATTEMPT_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function isClaimGenerationId(value: unknown): value is string {
  return typeof value === 'string' && CLAIM_GENERATION_ID_RE.test(value);
}

/** One id per logical acquisition. Retries of that request must reuse it. */
export function createClaimAttemptId(): string {
  const randomUUID = globalThis.crypto?.randomUUID;
  if (typeof randomUUID !== 'function') {
    throw new Error('Invalid claim request.');
  }
  const value = randomUUID.call(globalThis.crypto).toLowerCase();
  if (!CLAIM_ATTEMPT_ID_RE.test(value)) {
    throw new Error('Invalid claim request.');
  }
  return value;
}

const NANOS_MAX = 999999999;

/**
 * The exact claimStartedAt of a generationless legacy claim, as the server
 * contract echoes it: { seconds, nanoseconds }. It is a claim-cycle
 * discriminator, not a generation id and not ownership. Anything that is not
 * a stored Timestamp with integer parts returns null, so callers fail closed.
 */
export type LegacyClaimStartedAt = { seconds: number; nanoseconds: number };

/** Request value: exactly { seconds, nanoseconds }, both integers, as the server parses it. */
export function parseLegacyClaimStartedAt(value: unknown): LegacyClaimStartedAt | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const keys = Object.keys(value);
  if (keys.length !== 2 || !keys.includes('seconds') || !keys.includes('nanoseconds')) return null;
  const { seconds, nanoseconds } = value as { seconds?: unknown; nanoseconds?: unknown };
  if (!Number.isSafeInteger(seconds)) return null;
  if (!Number.isInteger(nanoseconds) || (nanoseconds as number) < 0 || (nanoseconds as number) > NANOS_MAX) return null;
  return { seconds: seconds as number, nanoseconds: nanoseconds as number };
}

/** Stored value: a Firestore Timestamp as read. Anything else has no fingerprint. */
export function legacyClaimStartedAt(value: unknown): LegacyClaimStartedAt | null {
  if (!value || typeof value !== 'object' || typeof (value as { toMillis?: unknown }).toMillis !== 'function') return null;
  const { seconds, nanoseconds } = value as { seconds?: unknown; nanoseconds?: unknown };
  return parseLegacyClaimStartedAt({ seconds, nanoseconds });
}

/** True only when a spot has no claimGenerationId at all (absent or null). */
export function isGenerationless(spot: Record<string, unknown> | null | undefined): boolean {
  return !!spot && (spot.claimGenerationId === undefined || spot.claimGenerationId === null);
}
