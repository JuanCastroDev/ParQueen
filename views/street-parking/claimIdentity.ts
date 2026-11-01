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
