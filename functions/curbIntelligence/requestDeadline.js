'use strict';

const { randomUUID } = require('node:crypto');

// Single end-to-end server-side budget. CSCL acquisition, official lookup,
// canonical processing and persistence all share this deadline.
const OVERALL_DEADLINE_MS = 8000;

function childBudgetMs(ownMs, options = {}) {
  const own = Number.isFinite(ownMs) ? Math.max(0, ownMs) : 0;
  const now = typeof options.now === 'function' ? options.now() : Date.now();
  if (options.signal?.aborted) return 0;
  if (Number.isFinite(options.deadlineAt)) {
    return Math.max(0, Math.min(own, options.deadlineAt - now));
  }
  if (Number.isFinite(options.remainingMs)) {
    return Math.max(0, Math.min(own, options.remainingMs));
  }
  return own;
}

function createRequestDeadline(options = {}) {
  const nowFn = typeof options.now === 'function' ? options.now : Date.now;
  const budgetMs = Number.isFinite(options.budgetMs) ? options.budgetMs : OVERALL_DEADLINE_MS;
  const startedAt = Number.isFinite(options.startedAt) ? options.startedAt : nowFn();
  const deadlineAt = startedAt + budgetMs;
  const controller = new AbortController();
  const persistEpoch = { token: randomUUID(), valid: true };
  let disposed = false;

  const remainingMs = () => {
    if (controller.signal.aborted) return 0;
    return Math.max(0, deadlineAt - nowFn());
  };

  const persistAllowed = (token) => (
    persistEpoch.valid
    && typeof token === 'string'
    && token === persistEpoch.token
    && !controller.signal.aborted
    && nowFn() < deadlineAt
  );

  const expire = () => {
    persistEpoch.valid = false;
    if (!controller.signal.aborted) controller.abort();
  };

  if (options.signal?.aborted) expire();
  else options.signal?.addEventListener('abort', expire, { once: true });

  const timer = setTimeout(expire, Math.max(0, deadlineAt - nowFn()));

  return {
    signal: controller.signal,
    startedAt,
    deadlineAt,
    budgetMs,
    persistToken: persistEpoch.token,
    remainingMs,
    persistAllowed,
    childBudgetMs(ownMs) {
      return childBudgetMs(ownMs, { deadlineAt, signal: controller.signal, now: nowFn });
    },
    expire,
    dispose() {
      if (disposed) return;
      disposed = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', expire);
    },
  };
}

module.exports = {
  OVERALL_DEADLINE_MS,
  childBudgetMs,
  createRequestDeadline,
};