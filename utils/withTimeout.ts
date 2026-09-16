/**
 * Bound a Promise so offline/network hangs cannot block startup forever.
 * The underlying Promise may still settle later; callers must ignore stale results.
 */
export class TimeoutError extends Error {
  readonly timedOut = true as const;

  constructor(message = 'Operation timed out') {
    super(message);
    this.name = 'TimeoutError';
  }
}

export function isTimeoutError(error: unknown): error is TimeoutError {
  return (
    error instanceof TimeoutError
    || (Boolean(error)
      && typeof error === 'object'
      && (error as { name?: string; timedOut?: boolean }).name === 'TimeoutError'
      && (error as { timedOut?: boolean }).timedOut === true)
  );
}

export function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label = 'operation',
): Promise<T> {
  if (!Number.isFinite(ms) || ms <= 0) {
    return promise;
  }

  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new TimeoutError(`${label} timed out after ${ms}ms`));
    }, ms);

    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
