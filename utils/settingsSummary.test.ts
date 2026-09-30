import { describe, it, expect } from 'vitest';
import { getNotificationsSummaryState, getLocationSummaryState } from './settingsSummary';

describe('getNotificationsSummaryState', () => {
  it('enabled + radius returns on key and shows radius', () => {
    const s = getNotificationsSummaryState(true, 1);
    expect(s.statusKey).toBe('settings.notif_on');
    expect(s.showRadius).toBe(true);
    expect(s.radius).toBe(1);
  });

  it('disabled returns off key and hides radius', () => {
    const s = getNotificationsSummaryState(false, 2);
    expect(s.statusKey).toBe('settings.notif_off');
    expect(s.showRadius).toBe(false);
  });

  it('passes through any valid radius', () => {
    expect(getNotificationsSummaryState(true, 5).radius).toBe(5);
  });

  it('does not report On when the product preference is true but delivery is not registered', () => {
    const s = getNotificationsSummaryState(true, 1, {
      capability: 'supported', permission: 'default', registration: 'not_registered',
    });
    expect(s.statusKey).toBe('settings.notif_not_ready');
    expect(s.showRadius).toBe(false);
  });

  it('reports On only for granted registered delivery', () => {
    const s = getNotificationsSummaryState(true, 2, {
      capability: 'supported', permission: 'granted', registration: 'registered',
    });
    expect(s.statusKey).toBe('settings.notif_on');
    expect(s.showRadius).toBe(true);
  });

  it('reports the iOS native shell as unavailable rather than On or Off', () => {
    const s = getNotificationsSummaryState(true, 1, {
      capability: 'ios_native_unavailable', permission: 'unavailable', registration: 'not_registered',
    });
    expect(s.statusKey).toBe('settings.notif_unavailable');
    expect(s.showRadius).toBe(false);
  });

  it('reports unavailable separately from Off', () => {
    const s = getNotificationsSummaryState(true, 1, {
      capability: 'unsupported', permission: 'unavailable', registration: 'not_registered',
    });
    expect(s.statusKey).toBe('settings.notif_unavailable');
  });
});

describe('getLocationSummaryState', () => {
  it('granted + precise on: includes permission key and precise-on key', () => {
    const s = getLocationSummaryState('granted', true);
    expect(s.permissionKey).toBe('settings.location_allowed');
    expect(s.preciseKey).toBe('settings.precise_on');
  });

  it('granted + precise off: includes permission key and precise-off key', () => {
    const s = getLocationSummaryState('granted', false);
    expect(s.permissionKey).toBe('settings.location_allowed');
    expect(s.preciseKey).toBe('settings.precise_off');
  });

  it('not_determined: correct key, no preciseKey', () => {
    const s = getLocationSummaryState('not_determined', true);
    expect(s.permissionKey).toBe('settings.location_not_enabled');
    expect(s.preciseKey).toBeUndefined();
  });

  it('permanently_blocked: correct key, no preciseKey', () => {
    const s = getLocationSummaryState('permanently_blocked', true);
    expect(s.permissionKey).toBe('settings.location_blocked');
    expect(s.preciseKey).toBeUndefined();
  });

  it('denied_requestable: correct key, no preciseKey', () => {
    const s = getLocationSummaryState('denied_requestable', false);
    expect(s.permissionKey).toBe('settings.location_not_allowed');
    expect(s.preciseKey).toBeUndefined();
  });

  it('services_disabled: correct key, no preciseKey', () => {
    const s = getLocationSummaryState('services_disabled', false);
    expect(s.permissionKey).toBe('settings.location_services_off');
    expect(s.preciseKey).toBeUndefined();
  });
});
