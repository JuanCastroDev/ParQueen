import { describe, it, expect, vi, beforeEach } from 'vitest';

const { captureException, withScope } = vi.hoisted(() => ({
  captureException: vi.fn(),
  withScope: vi.fn((cb: (scope: any) => void) => {
    const scope = { setTag: vi.fn() };
    cb(scope);
    return scope;
  }),
}));

vi.mock('@sentry/react', () => ({ captureException, withScope }));

import { captureClientException, reportCriticalActionFailure } from './errorReporting';

describe('captureClientException', () => {
  beforeEach(() => {
    captureException.mockClear();
    withScope.mockClear();
  });

  it('reports the error to Sentry', () => {
    const error = new Error('boom');
    captureClientException(error);
    expect(captureException).toHaveBeenCalledWith(error);
  });

  it('tags only the allowlisted context fields (route/component/errorCode)', () => {
    let capturedScope: any;
    withScope.mockImplementationOnce((cb: (scope: any) => void) => {
      capturedScope = { setTag: vi.fn() };
      cb(capturedScope);
      return capturedScope;
    });
    captureClientException(new Error('boom'), { route: 'map', component: 'StreetIntelligenceCard', errorCode: 'permission-denied' });
    expect(capturedScope.setTag).toHaveBeenCalledWith('route', 'map');
    expect(capturedScope.setTag).toHaveBeenCalledWith('component', 'StreetIntelligenceCard');
    expect(capturedScope.setTag).toHaveBeenCalledWith('errorCode', 'permission-denied');
    expect(capturedScope.setTag).toHaveBeenCalledTimes(3);
  });

  it('does not attach arbitrary fields — props and other objects stay off the allowlist', () => {
    let capturedScope: any;
    withScope.mockImplementationOnce((cb: (scope: any) => void) => {
      capturedScope = { setTag: vi.fn() };
      cb(capturedScope);
      return capturedScope;
    });
    // @ts-expect-error — props/state/arbitrary objects are not part of the allowlisted context type
    captureClientException(new Error('boom'), { props: { secret: 'x' } });
    const taggedKeys = capturedScope.setTag.mock.calls.map((call: any[]) => call[0]);
    expect(taggedKeys).not.toContain('props');
  });

  it('works with no context at all', () => {
    expect(() => captureClientException(new Error('boom'))).not.toThrow();
    expect(captureException).toHaveBeenCalled();
  });
});

describe('reportCriticalActionFailure', () => {
  beforeEach(() => {
    captureException.mockClear();
    withScope.mockClear();
  });

  it('reports the allowed action exactly once', () => {
    reportCriticalActionFailure('ping_create', new Error('boom'));
    expect(captureException).toHaveBeenCalledTimes(1);
  });

  it('attaches a stable action tag', () => {
    let scope: any;
    withScope.mockImplementationOnce((cb: (scope: any) => void) => { scope = { setTag: vi.fn() }; cb(scope); return scope; });
    reportCriticalActionFailure('spot_claim', new Error('boom'));
    expect(scope.setTag).toHaveBeenCalledWith('action', 'spot_claim');
  });

  it('has no surface field — no surface was actually wired up at any real call site in this PR', () => {
    // @ts-expect-error — surface is not part of CriticalActionContext
    reportCriticalActionFailure('spot_claim', new Error('boom'), { surface: 'map' });
  });

  it('attaches the operationType tag when provided', () => {
    let scope: any;
    withScope.mockImplementationOnce((cb: (scope: any) => void) => { scope = { setTag: vi.fn() }; cb(scope); return scope; });
    reportCriticalActionFailure('ping_create', new Error('boom'), { operationType: 'scheduled' });
    expect(scope.setTag).toHaveBeenCalledWith('operationType', 'scheduled');
  });

  it('derives a safe errorCode tag from a Firebase-style error.code', () => {
    let scope: any;
    withScope.mockImplementationOnce((cb: (scope: any) => void) => { scope = { setTag: vi.fn() }; cb(scope); return scope; });
    const firebaseError = Object.assign(new Error('Missing or insufficient permissions.'), { code: 'permission-denied' });
    reportCriticalActionFailure('spot_claim', firebaseError);
    expect(scope.setTag).toHaveBeenCalledWith('errorCode', 'permission-denied');
  });

  it('falls back to the error name when there is no .code', () => {
    let scope: any;
    withScope.mockImplementationOnce((cb: (scope: any) => void) => { scope = { setTag: vi.fn() }; cb(scope); return scope; });
    reportCriticalActionFailure('spot_claim', new TypeError('boom'));
    expect(scope.setTag).toHaveBeenCalledWith('errorCode', 'TypeError');
  });

  it('an explicit context.errorCode overrides the code derived from the error', () => {
    let scope: any;
    withScope.mockImplementationOnce((cb: (scope: any) => void) => { scope = { setTag: vi.fn() }; cb(scope); return scope; });
    const firebaseError = Object.assign(new Error('boom'), { code: 'internal' });
    reportCriticalActionFailure('spot_claim', firebaseError, { errorCode: 'not-found' });
    expect(scope.setTag).toHaveBeenCalledWith('errorCode', 'not-found');
  });

  it('does not accept arbitrary context fields — the type only allows surface/errorCode/operationType', () => {
    // @ts-expect-error — uid/spotId/etc are not part of the allowlisted context type
    reportCriticalActionFailure('spot_claim', new Error('boom'), { spotId: 'abc123', uid: 'u1' });
  });

  it('never sends the original error message — only a sanitized, action-scoped message', () => {
    reportCriticalActionFailure('account_create', new Error('failed for user someone@example.com'));
    const sentError = captureException.mock.calls[0][0];
    expect(sentError.message).not.toContain('someone@example.com');
    expect(sentError.message).toContain('account_create');
  });

  it('does NOT copy the original stack verbatim — a V8 stack begins with "Name: message", which would reintroduce the original message', () => {
    const original = new Error('boom');
    reportCriticalActionFailure('ping_create', original);
    const sentError = captureException.mock.calls[0][0];
    expect(sentError.stack).not.toBe(original.stack);
  });

  it('the synthetic exception keeps its own stack, which still contains real reporting call-site frames', () => {
    reportCriticalActionFailure('ping_create', new Error('boom'));
    const sentError = captureException.mock.calls[0][0];
    expect(sentError.stack).toContain('reportCriticalActionFailure');
  });

  describe('privacy regression — a distinctive secret-like original message must never reach Sentry', () => {
    const SECRET = 'USER_PRIVATE_TEXT_123456';

    it('reports exactly once', () => {
      reportCriticalActionFailure('account_create', new Error(SECRET));
      expect(captureException).toHaveBeenCalledTimes(1);
    });

    it('captured exception.message does not contain the secret', () => {
      reportCriticalActionFailure('account_create', new Error(SECRET));
      const sentError = captureException.mock.calls[0][0];
      expect(sentError.message).not.toContain(SECRET);
    });

    it('captured exception.stack does not contain the secret', () => {
      reportCriticalActionFailure('account_create', new Error(SECRET));
      const sentError = captureException.mock.calls[0][0];
      expect(sentError.stack).not.toContain(SECRET);
    });

    it('synthetic exception message is exactly critical_action_failure:<action>', () => {
      reportCriticalActionFailure('account_create', new Error(SECRET));
      const sentError = captureException.mock.calls[0][0];
      expect(sentError.message).toBe('critical_action_failure:account_create');
    });

    it('the secret is not used as the errorCode tag even if it were placed on error.code', () => {
      let scope: any;
      withScope.mockImplementationOnce((cb: (scope: any) => void) => { scope = { setTag: vi.fn() }; cb(scope); return scope; });
      reportCriticalActionFailure('account_create', Object.assign(new Error('boom'), { code: SECRET }));
      expect(scope.setTag).toHaveBeenCalledWith('errorCode', 'unknown');
    });

    it('error.message is never read for the errorCode tag, even when .code/.name are absent', () => {
      let scope: any;
      withScope.mockImplementationOnce((cb: (scope: any) => void) => { scope = { setTag: vi.fn() }; cb(scope); return scope; });
      const bareError = { message: SECRET };
      reportCriticalActionFailure('account_create', bareError);
      const taggedErrorCode = scope.setTag.mock.calls.find((c: any[]) => c[0] === 'errorCode');
      expect(taggedErrorCode).toBeUndefined();
    });
  });

  describe('errorCode normalization — never a free-form or oversized value', () => {
    it('a normal Firebase-style code is preserved as-is', () => {
      let scope: any;
      withScope.mockImplementationOnce((cb: (scope: any) => void) => { scope = { setTag: vi.fn() }; cb(scope); return scope; });
      reportCriticalActionFailure('spot_claim', Object.assign(new Error('x'), { code: 'functions/failed-precondition' }));
      expect(scope.setTag).toHaveBeenCalledWith('errorCode', 'functions/failed-precondition');
    });

    it('an oversized code collapses to "unknown"', () => {
      let scope: any;
      withScope.mockImplementationOnce((cb: (scope: any) => void) => { scope = { setTag: vi.fn() }; cb(scope); return scope; });
      const huge = 'a'.repeat(500);
      reportCriticalActionFailure('spot_claim', Object.assign(new Error('x'), { code: huge }));
      expect(scope.setTag).toHaveBeenCalledWith('errorCode', 'unknown');
    });

    it('a code containing free-form/unsafe characters (spaces, punctuation) collapses to "unknown"', () => {
      let scope: any;
      withScope.mockImplementationOnce((cb: (scope: any) => void) => { scope = { setTag: vi.fn() }; cb(scope); return scope; });
      reportCriticalActionFailure('spot_claim', Object.assign(new Error('x'), { code: 'contact me at a@b.com!' }));
      expect(scope.setTag).toHaveBeenCalledWith('errorCode', 'unknown');
    });

    it('an explicit context.errorCode is normalized too, not trusted verbatim', () => {
      let scope: any;
      withScope.mockImplementationOnce((cb: (scope: any) => void) => { scope = { setTag: vi.fn() }; cb(scope); return scope; });
      reportCriticalActionFailure('spot_claim', new Error('x'), { errorCode: 'free form text with spaces' });
      expect(scope.setTag).toHaveBeenCalledWith('errorCode', 'unknown');
    });
  });

  it('never throws into the caller, even if Sentry itself throws', () => {
    withScope.mockImplementationOnce(() => { throw new Error('sentry is down'); });
    expect(() => reportCriticalActionFailure('ping_create', new Error('boom'))).not.toThrow();
  });

  it('never throws when given a non-Error value', () => {
    expect(() => reportCriticalActionFailure('ping_create', 'a plain string error')).not.toThrow();
    expect(captureException).toHaveBeenCalledTimes(1);
  });
});
