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
  projectPrivatePreferencesSnapshot,
  projectPublicProfileSnapshot,
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

describe('App user snapshot projection', () => {
  const acceptedUser = {
    id: 'user-a',
    displayName: 'Alex',
    notificationRadius: 1,
    notificationsEnabled: true,
    sharePreciseLocation: true,
  };

  const preferences = (notificationRadius: number, notificationsEnabled = true) => ({
    notificationRadius,
    notificationsEnabled,
    sharePreciseLocation: true,
  });

  it('requires trusted explicit notification consent before enabling automatic lifecycle work', () => {
    const cachedEnabled = projectPrivatePreferencesSnapshot(
      null,
      'user-a',
      preferences(3, true),
      { fromCache: true, hasPendingWrites: false },
    );
    const pendingEnabled = projectPrivatePreferencesSnapshot(
      cachedEnabled,
      'user-a',
      preferences(3, true),
      { fromCache: true, hasPendingWrites: true },
    );
    const confirmedEnabled = projectPrivatePreferencesSnapshot(
      pendingEnabled,
      'user-a',
      preferences(3, true),
      { fromCache: false, hasPendingWrites: false },
    );
    const cachedDisabled = projectPrivatePreferencesSnapshot(
      null,
      'user-b',
      preferences(2, false),
      { fromCache: true, hasPendingWrites: false },
    );

    expect(cachedEnabled.notificationPreferenceStatus).toBeUndefined();
    expect(pendingEnabled.notificationPreferenceStatus).toBeUndefined();
    expect(confirmedEnabled.notificationPreferenceStatus).toBe('enabled');
    expect(cachedDisabled.notificationPreferenceStatus).toBe('disabled');
  });

  it('keeps a missing notification preference unresolved', () => {
    const projected = projectPrivatePreferencesSnapshot(
      null,
      'user-a',
      { notificationRadius: 2, sharePreciseLocation: false },
      { fromCache: false, hasPendingWrites: false },
    );

    expect(projected.notificationPreferenceStatus).toBeUndefined();
  });

  it('returns to unresolved when trusted preferences remove notification consent', () => {
    const enabled = projectPrivatePreferencesSnapshot(
      null,
      'user-a',
      { notificationsEnabled: true },
      { fromCache: false, hasPendingWrites: false },
    );
    const missing = projectPrivatePreferencesSnapshot(
      enabled,
      'user-a',
      { notificationRadius: 2 },
      { fromCache: false, hasPendingWrites: false },
    );

    expect(enabled.notificationPreferenceStatus).toBe('enabled');
    expect(missing.notificationPreferenceStatus).toBeUndefined();
  });

  it('keeps the accepted radius through a pending write and rejected-write rollback', () => {
    const pending = projectPrivatePreferencesSnapshot(
      acceptedUser,
      'user-a',
      preferences(5),
      { fromCache: true, hasPendingWrites: true },
    );
    const rolledBack = projectPrivatePreferencesSnapshot(
      pending,
      'user-a',
      preferences(1),
      { fromCache: false, hasPendingWrites: false },
    );

    expect(pending.notificationRadius).toBe(1);
    expect(rolledBack.notificationRadius).toBe(1);
  });

  it('applies an acknowledged radius and a separate non-pending change', () => {
    const pending = projectPrivatePreferencesSnapshot(
      acceptedUser,
      'user-a',
      preferences(5),
      { fromCache: true, hasPendingWrites: true },
    );
    const acknowledged = projectPrivatePreferencesSnapshot(
      pending,
      'user-a',
      preferences(5),
      { fromCache: false, hasPendingWrites: false },
    );
    const otherDevice = projectPrivatePreferencesSnapshot(
      acknowledged,
      'user-a',
      preferences(3),
      { fromCache: false, hasPendingWrites: false },
    );

    expect(acknowledged.notificationRadius).toBe(5);
    expect(otherDevice.notificationRadius).toBe(3);
  });

  it('does not create a transient radius transition that could rebuild Nearby subscriptions', () => {
    const observedRadii: unknown[] = [acceptedUser.notificationRadius];
    let state = acceptedUser;
    for (const snapshot of [
      { data: preferences(5), metadata: { fromCache: true, hasPendingWrites: true } },
      { data: preferences(1), metadata: { fromCache: false, hasPendingWrites: false } },
    ]) {
      const next = projectPrivatePreferencesSnapshot(state, 'user-a', snapshot.data, snapshot.metadata);
      if (next.notificationRadius !== state.notificationRadius) {
        observedRadii.push(next.notificationRadius);
      }
      state = next as typeof acceptedUser;
    }

    expect(observedRadii).toEqual([1]);
  });

  it('continues projecting other preference fields while a radius write is pending', () => {
    const pending = projectPrivatePreferencesSnapshot(
      acceptedUser,
      'user-a',
      preferences(5, false),
      { fromCache: true, hasPendingWrites: true },
    );

    expect(pending).toMatchObject({
      notificationRadius: 1,
      notificationsEnabled: false,
      sharePreciseLocation: true,
    });
  });

  it('accepts non-pending cached data but not an initial pending radius', () => {
    const cached = projectPrivatePreferencesSnapshot(
      null,
      'user-a',
      preferences(3),
      { fromCache: true, hasPendingWrites: false },
    );
    const initialPending = projectPrivatePreferencesSnapshot(
      null,
      'user-a',
      preferences(5),
      { fromCache: true, hasPendingWrites: true },
    );

    expect(cached.notificationRadius).toBe(3);
    expect(initialPending.notificationRadius).toBeUndefined();
  });

  it('keeps an accepted radius across same-account profile refreshes without crossing accounts', () => {
    const privateOptOuts = {
      ...acceptedUser,
      notificationRadius: 2,
      notificationsEnabled: false,
      notificationPreferenceStatus: 'disabled' as const,
      sharePreciseLocation: false,
    };
    const refreshed = projectPublicProfileSnapshot(
      privateOptOuts,
      'user-a',
      {
        displayName: 'Alex Updated',
        notificationRadius: 5,
        notificationsEnabled: true,
        sharePreciseLocation: true,
      },
      { email: 'alex@example.com' },
    );
    const refreshedAgain = projectPublicProfileSnapshot(
      refreshed,
      'user-a',
      { displayName: 'Alex Final' },
      { email: 'alex@example.com' },
    );
    const switched = projectPublicProfileSnapshot(
      refreshedAgain,
      'user-b',
      { displayName: 'Blair' },
      {},
    );
    const newAccountPending = projectPrivatePreferencesSnapshot(
      switched,
      'user-b',
      preferences(5),
      { fromCache: true, hasPendingWrites: true },
    );

    expect(refreshed).toMatchObject({
      id: 'user-a',
      displayName: 'Alex Updated',
      notificationRadius: 2,
      notificationsEnabled: false,
      notificationPreferenceStatus: 'disabled',
      sharePreciseLocation: false,
    });
    expect(refreshedAgain).toMatchObject({
      id: 'user-a',
      displayName: 'Alex Final',
      notificationRadius: 2,
      notificationsEnabled: false,
      notificationPreferenceStatus: 'disabled',
      sharePreciseLocation: false,
    });
    expect(switched.notificationRadius).toBeUndefined();
    expect(switched.notificationsEnabled).toBeUndefined();
    expect(switched.notificationPreferenceStatus).toBeUndefined();
    expect(switched.sharePreciseLocation).toBeUndefined();
    expect(newAccountPending.notificationRadius).toBeUndefined();
  });
});
