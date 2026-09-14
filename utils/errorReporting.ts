import * as Sentry from '@sentry/react';

/**
 * The only context fields callers may attach to a reported exception.
 * Deliberately narrow — no props, no state, no request bodies, no arbitrary
 * objects. Business-action instrumentation (which action/route failed) is a
 * separate, later PR; this type exists now so the allowlist is enforced by
 * the type system from the start, not bolted on afterward.
 */
export interface SafeErrorContext {
  route?: string;
  component?: string;
  errorCode?: string;
}

/**
 * The single sanctioned way to report a client exception. Context is
 * allowlisted by this function's own signature, not by convention.
 */
export function captureClientException(error: unknown, context?: SafeErrorContext): void {
  Sentry.withScope((scope) => {
    if (context?.route) scope.setTag('route', context.route);
    if (context?.component) scope.setTag('component', context.component);
    if (context?.errorCode) scope.setTag('errorCode', context.errorCode);
    Sentry.captureException(error);
  });
}

/**
 * Client actions important enough that a terminal, user-visible failure
 * should also reach Sentry — even though the app already handles the
 * failure locally and never lets it become an uncaught exception. Add a
 * value here only when it is actually wired up at a real terminal catch;
 * see docs/PR body for the audit of what was and wasn't instrumented and why.
 */
export type CriticalAction =
  | 'account_create'
  | 'ping_create'
  | 'spot_claim'
  | 'claim_cancel'
  | 'message_send'
  | 'chat_delete'
  | 'chat_init';

/**
 * Deliberately tiny and low-cardinality — no document/user identifiers, no
 * coordinates, no message content. `operationType` exists only for actions
 * that have a real immediate/scheduled duality (Ping creation today). There
 * is deliberately no `surface` field: nothing in this PR actually wires one
 * up, and an unused free-string field would only widen the allowlist for no
 * reason — add it back as a real finite union if a call site ever needs it.
 */
export interface CriticalActionContext {
  errorCode?: string;
  operationType?: 'immediate' | 'scheduled';
}

// Only ever reads .code/.name — NEVER .message, which is the one field on an
// error that can plausibly echo user-entered or backend-provided free text.
function extractRawErrorCode(error: unknown): string | undefined {
  if (error && typeof error === 'object' && typeof (error as { code?: unknown }).code === 'string') {
    return (error as { code: string }).code;
  }
  if (error instanceof Error && error.name) return error.name;
  return undefined;
}

// An explicit allowlist, not a permissive character-class regex: a regex
// like /^[A-Za-z0-9_.-]+$/ would happily pass a secret-shaped value (e.g. an
// opaque token or a SCREAMING_SNAKE_CASE identifier someone put in
// error.code by mistake) straight through, since alphanumeric-plus-
// underscore is indistinguishable from a real code by shape alone. Only
// values actually known to be safe (standard Firestore/Cloud Functions
// error codes and native JS error names) are ever tagged verbatim.
const KNOWN_ERROR_CODES = new Set([
  'ok', 'cancelled', 'unknown', 'invalid-argument', 'deadline-exceeded', 'not-found',
  'already-exists', 'permission-denied', 'resource-exhausted', 'failed-precondition',
  'aborted', 'out-of-range', 'unimplemented', 'internal', 'unavailable', 'data-loss',
  'unauthenticated',
  'Error', 'TypeError', 'RangeError', 'SyntaxError', 'ReferenceError', 'EvalError', 'URIError',
  'FirebaseError',
]);
const FUNCTIONS_PREFIX = 'functions/';

function normalizeErrorCode(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  const bare = trimmed.startsWith(FUNCTIONS_PREFIX) ? trimmed.slice(FUNCTIONS_PREFIX.length) : trimmed;
  if (!KNOWN_ERROR_CODES.has(trimmed) && !KNOWN_ERROR_CODES.has(bare)) {
    return 'unknown';
  }
  return trimmed;
}

// Never forwards error.message or error.stack: a V8 stack's own first line
// is "Name: message", so copying it would silently reintroduce exactly the
// message this function exists to strip. The synthetic Error's own natively
// generated stack (captured right here, at the reporting call site) is kept
// instead — it already shows the real action/catch-block/caller chain,
// which is all the diagnostic value a private-beta failure report needs.
function sanitizeError(action: CriticalAction): Error {
  const safe = new Error(`critical_action_failure:${action}`);
  safe.name = 'CriticalActionFailure';
  return safe;
}

/**
 * The single sanctioned way to report a terminal, already-handled failure
 * of a critical client action. Never throws, never blocks the caller, and
 * is a safe no-op if Sentry itself is unavailable or misbehaves.
 */
export function reportCriticalActionFailure(
  action: CriticalAction,
  error: unknown,
  context?: CriticalActionContext
): void {
  try {
    const errorCode = normalizeErrorCode(context?.errorCode ?? extractRawErrorCode(error));
    Sentry.withScope((scope) => {
      scope.setTag('action', action);
      if (context?.operationType) scope.setTag('operationType', context.operationType);
      if (errorCode) scope.setTag('errorCode', errorCode);
      Sentry.captureException(sanitizeError(action));
    });
  } catch {
    // Monitoring must never affect the product.
  }
}
