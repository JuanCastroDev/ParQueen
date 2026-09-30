import { describe, expect, it } from 'vitest';
import { deriveNotificationPresentation } from './notificationPresentation';

describe('notification runtime presentation', () => {
  it('never calls a preference-only state enabled', () => {
    expect(deriveNotificationPresentation(true, null)).toEqual({ kind: 'checking', action: 'none' });
    expect(deriveNotificationPresentation(true, {
      capability: 'supported', permission: 'default', registration: 'not_registered',
    })).toEqual({ kind: 'enable', action: 'enable' });
  });

  it('reports enabled only when preference, permission, and registration all agree', () => {
    expect(deriveNotificationPresentation(true, {
      capability: 'supported', permission: 'granted', registration: 'registered',
    })).toEqual({ kind: 'enabled', action: 'none' });
    expect(deriveNotificationPresentation(false, {
      capability: 'supported', permission: 'granted', registration: 'registered',
    })).toEqual({ kind: 'off', action: 'enable' });
  });

  it('keeps platform, permission, and registration failures distinct', () => {
    expect(deriveNotificationPresentation(true, {
      capability: 'ios_native_unavailable', permission: 'unavailable', registration: 'not_registered',
    })).toEqual({ kind: 'ios_native_unavailable', action: 'none' });
    expect(deriveNotificationPresentation(true, {
      capability: 'ios_install_required', permission: 'unavailable', registration: 'not_registered',
    })).toEqual({ kind: 'ios_install_required', action: 'none' });
    expect(deriveNotificationPresentation(true, {
      capability: 'unsupported', permission: 'unavailable', registration: 'not_registered',
    })).toEqual({ kind: 'unsupported', action: 'none' });
    expect(deriveNotificationPresentation(true, {
      capability: 'supported', permission: 'denied', registration: 'not_registered',
    })).toEqual({ kind: 'denied', action: 'recheck' });
    expect(deriveNotificationPresentation(true, {
      capability: 'supported', permission: 'granted', registration: 'failed',
    })).toEqual({ kind: 'registration_failed', action: 'retry' });
  });
});
