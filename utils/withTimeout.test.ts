import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TimeoutError, isTimeoutError, withTimeout } from './withTimeout';

describe('withTimeout', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('resolves when the promise settles before the timeout', async () => {
    const resultPromise = withTimeout(Promise.resolve('ok'), 1000, 'fast');
    await expect(resultPromise).resolves.toBe('ok');
  });

  it('rejects with TimeoutError when the promise never settles', async () => {
    const hang = new Promise<string>(() => {});
    const resultPromise = withTimeout(hang, 1000, 'hang');
    const assertion = expect(resultPromise).rejects.toSatisfy(
      (err: unknown) => isTimeoutError(err) && err instanceof TimeoutError,
    );
    await vi.advanceTimersByTimeAsync(1000);
    await assertion;
  });

  it('rejects with the original error when the promise fails before timeout', async () => {
    const resultPromise = withTimeout(Promise.reject(new Error('boom')), 1000, 'fail');
    await expect(resultPromise).rejects.toThrow('boom');
  });
});
