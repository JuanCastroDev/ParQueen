import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppView } from '../types';
import {
  AUTH_BOOTSTRAP_LOCATION_TIMEOUT_MS,
  AUTH_BOOTSTRAP_TIMEOUT_MS,
  classifyProfileSnapshot,
  createBootstrapDeadline,
  createBootstrapGenerationTracker,
  decideAdminDomainAuthenticatedView,
  decideAuthenticatedConsumerBootstrap,
  decideLoggedOutStartupView,
  isExpectedBootstrapUnavailable,
  lookupProfileBootstrapStatus,
} from './authBootstrap';
import { TimeoutError, withTimeout } from './withTimeout';

describe('decideAuthenticatedConsumerBootstrap', () => {
  it('keeps existing online routing for a confirmed profile', () => {
    expect(decideAuthenticatedConsumerBootstrap('exists', 'granted')).toEqual({
      view: AppView.MAP,
      seedMinimalUser: false,
    });
    expect(decideAuthenticatedConsumerBootstrap('exists', 'unknown')).toEqual({
      view: AppView.LOCATION_PROMPT,
      seedMinimalUser: false,
    });
  });

  it('routes confirmed missing profile to SETUP_PROFILE', () => {
    expect(decideAuthenticatedConsumerBootstrap('missing', 'granted')).toEqual({
      view: AppView.SETUP_PROFILE,
      seedMinimalUser: false,
    });
  });

  it('does not treat unavailable/offline profile lookup as SETUP_PROFILE', () => {
    expect(decideAuthenticatedConsumerBootstrap('unavailable', 'granted')).toEqual({
      view: AppView.MAP,
      seedMinimalUser: true,
    });
    expect(decideAuthenticatedConsumerBootstrap('unavailable', 'unknown')).toEqual({
      view: AppView.LOCATION_PROMPT,
      seedMinimalUser: true,
    });
    expect(decideAuthenticatedConsumerBootstrap('unavailable', 'declined').view).not.toBe(
      AppView.SETUP_PROFILE,
    );
  });
});

describe('logged-out and admin-domain routing helpers', () => {
  it('routes logged-out normal domain by onboarding flag', () => {
    expect(
      decideLoggedOutStartupView({ isAdminDomain: false, hasSeenOnboarding: false }),
    ).toBe(AppView.ONBOARDING);
    expect(
      decideLoggedOutStartupView({ isAdminDomain: false, hasSeenOnboarding: true }),
    ).toBe(AppView.CREATE_ACCOUNT);
  });

  it('routes logged-out admin domain to ADMIN_LOGIN', () => {
    expect(
      decideLoggedOutStartupView({ isAdminDomain: true, hasSeenOnboarding: false }),
    ).toBe(AppView.ADMIN_LOGIN);
    expect(
      decideLoggedOutStartupView({ isAdminDomain: true, hasSeenOnboarding: true }),
    ).toBe(AppView.ADMIN_LOGIN);
  });

  it('routes authenticated admin-domain by token status', () => {
    expect(decideAdminDomainAuthenticatedView('admin')).toBe(AppView.ADMIN_DASHBOARD);
    expect(decideAdminDomainAuthenticatedView('non_admin')).toBe(AppView.ADMIN_LOGIN);
    expect(decideAdminDomainAuthenticatedView('unavailable')).toBe(AppView.ADMIN_LOGIN);
  });
});

describe('shared overall bootstrap deadline', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-16T12:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('clips location sub-timeout to remaining overall time', () => {
    const deadline = createBootstrapDeadline(AUTH_BOOTSTRAP_TIMEOUT_MS, () => Date.now());
    vi.advanceTimersByTime(5_000);
    expect(deadline.remainingMs()).toBe(1_000);
    expect(deadline.budgetMs(AUTH_BOOTSTRAP_LOCATION_TIMEOUT_MS)).toBe(1_000);
    expect(deadline.budgetMs(AUTH_BOOTSTRAP_LOCATION_TIMEOUT_MS)).toBeLessThan(
      AUTH_BOOTSTRAP_LOCATION_TIMEOUT_MS,
    );
  });

  it('token + profile sequential delays cannot exceed the single overall deadline', async () => {
    const deadline = createBootstrapDeadline(AUTH_BOOTSTRAP_TIMEOUT_MS, () => Date.now());
    const started = Date.now();

    const slowToken = new Promise<{ claims: { role?: string } }>((resolve) => {
      setTimeout(() => resolve({ claims: {} }), 4_000);
    });
    const tokenBudget = deadline.budgetMs();
    expect(tokenBudget).toBe(AUTH_BOOTSTRAP_TIMEOUT_MS);
    const tokenPromise = withTimeout(slowToken, tokenBudget, 'id-token');
    await vi.advanceTimersByTimeAsync(4_000);
    await expect(tokenPromise).resolves.toEqual({ claims: {} });

    const profileBudget = deadline.budgetMs();
    expect(profileBudget).toBe(2_000);

    const hangProfile = new Promise<{ exists: () => boolean }>(() => {});
    const profilePromise = lookupProfileBootstrapStatus(() => hangProfile, {
      timeoutMs: profileBudget,
      label: 'profile-get',
    });
    const assertion = expect(profilePromise).resolves.toBe('unavailable');
    await vi.advanceTimersByTimeAsync(2_000);
    await assertion;

    expect(Date.now() - started).toBe(AUTH_BOOTSTRAP_TIMEOUT_MS);
    expect(deadline.isExpired()).toBe(true);
    expect(deadline.budgetMs()).toBe(0);
  });

  it('total authenticated fallback occurs at the overall deadline, not 6s + 6s', async () => {
    const deadline = createBootstrapDeadline(AUTH_BOOTSTRAP_TIMEOUT_MS, () => Date.now());
    const started = Date.now();

    // Stage 1 burns almost the whole window.
    await vi.advanceTimersByTimeAsync(5_500);
    expect(deadline.budgetMs()).toBe(500);

    // Stage 2 gets only remaining 500ms — not a fresh 6s.
    const hang = new Promise<{ exists: () => boolean }>(() => {});
    const lookup = lookupProfileBootstrapStatus(() => hang, {
      timeoutMs: deadline.budgetMs(),
      label: 'profile-get',
    });
    const assertion = expect(lookup).resolves.toBe('unavailable');
    await vi.advanceTimersByTimeAsync(500);
    await assertion;

    expect(Date.now() - started).toBe(AUTH_BOOTSTRAP_TIMEOUT_MS);
    expect(Date.now() - started).toBeLessThan(12_000);

    const decision = decideAuthenticatedConsumerBootstrap('unavailable', 'granted');
    expect(decision.view).toBe(AppView.MAP);
    expect(decision.seedMinimalUser).toBe(true);
  });

  it('late token/profile/location completion after deadline cannot alter fallback/newer generation', async () => {
    const tracker = createBootstrapGenerationTracker();
    const gen1 = tracker.begin();
    const deadline = createBootstrapDeadline(AUTH_BOOTSTRAP_TIMEOUT_MS, () => Date.now());

    let resolveToken: ((value: { claims: { role: string } }) => void) | undefined;
    const lateToken = new Promise<{ claims: { role: string } }>((resolve) => {
      resolveToken = resolve;
    });

    const tokenAttempt = withTimeout(lateToken, deadline.budgetMs(), 'id-token');
    const tokenAssertion = expect(tokenAttempt).rejects.toBeInstanceOf(TimeoutError);
    await vi.advanceTimersByTimeAsync(AUTH_BOOTSTRAP_TIMEOUT_MS);
    await tokenAssertion;
    expect(deadline.isExpired()).toBe(true);

    // Fallback decision under gen1, then a newer auth generation starts.
    const fallback = decideAuthenticatedConsumerBootstrap('unavailable', 'unknown');
    expect(fallback.view).toBe(AppView.LOCATION_PROMPT);

    const gen2 = tracker.begin();
    expect(gen1.isCurrent()).toBe(false);
    expect(gen2.isCurrent()).toBe(true);

    // Late token arrives claiming admin — must not be applied when gen1 is stale.
    resolveToken!({ claims: { role: 'admin' } });
    await Promise.resolve();
    expect(gen1.isCurrent()).toBe(false);
    if (!gen1.isCurrent()) {
      // Callers skip setCurrentView(ADMIN_DASHBOARD) when generation is stale.
      expect(decideAdminDomainAuthenticatedView('admin')).toBe(AppView.ADMIN_DASHBOARD);
    }
  });

  it('admin-domain unavailable token maps to ADMIN_LOGIN within overall deadline', async () => {
    const deadline = createBootstrapDeadline(AUTH_BOOTSTRAP_TIMEOUT_MS, () => Date.now());
    const hang = new Promise<never>(() => {});
    const attempt = withTimeout(hang, deadline.budgetMs(), 'admin-id-token');
    const assertion = expect(attempt).rejects.toBeInstanceOf(TimeoutError);
    await vi.advanceTimersByTimeAsync(AUTH_BOOTSTRAP_TIMEOUT_MS);
    await assertion;
    expect(decideAdminDomainAuthenticatedView('unavailable')).toBe(AppView.ADMIN_LOGIN);
    expect(deadline.isExpired()).toBe(true);
  });
});

describe('lookupProfileBootstrapStatus', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns exists / missing from a settled read', async () => {
    await expect(
      lookupProfileBootstrapStatus(async () => ({ exists: () => true }), { timeoutMs: 1000 }),
    ).resolves.toBe('exists');
    await expect(
      lookupProfileBootstrapStatus(async () => ({ exists: () => false }), { timeoutMs: 1000 }),
    ).resolves.toBe('missing');
    expect(classifyProfileSnapshot(true)).toBe('exists');
    expect(classifyProfileSnapshot(false)).toBe('missing');
  });

  it('maps timeout / zero-budget reads to unavailable (not missing)', async () => {
    await expect(
      lookupProfileBootstrapStatus(() => new Promise(() => {}), { timeoutMs: 0 }),
    ).resolves.toBe('unavailable');

    const pending = lookupProfileBootstrapStatus(() => new Promise(() => {}), {
      timeoutMs: 1000,
      label: 'profile-lookup',
    });
    const assertion = expect(pending).resolves.toBe('unavailable');
    await vi.advanceTimersByTimeAsync(1000);
    await assertion;
  });

  it('maps expected network unavailable errors to unavailable', async () => {
    await expect(
      lookupProfileBootstrapStatus(
        async () => {
          throw { code: 'unavailable' };
        },
        { timeoutMs: 1000 },
      ),
    ).resolves.toBe('unavailable');
    expect(isExpectedBootstrapUnavailable(new TimeoutError('x'))).toBe(true);
  });
});
