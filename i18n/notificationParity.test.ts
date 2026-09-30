import { describe, expect, it } from 'vitest';
import en from './en';
import es from './es';

const notificationLaunchKeys = [
  'notifications.setup_checking',
  'notifications.setup_checking_body',
  'notifications.setup_enable',
  'notifications.setup_enable_body',
  'notifications.setup_enable_action',
  'notifications.setup_enabled',
  'notifications.setup_enabled_body',
  'notifications.setup_off',
  'notifications.setup_ios_title',
  'notifications.setup_ios_body',
  'notifications.setup_ios_steps',
  'notifications.setup_ios_native_title',
  'notifications.setup_ios_native_body',
  'notifications.setup_unsupported',
  'notifications.setup_unsupported_body',
  'notifications.setup_denied',
  'notifications.setup_denied_body',
  'notifications.setup_failed',
  'notifications.setup_failed_body',
  'notifications.setup_recheck',
  'notifications.setup_retry',
  'notifications.setup_working',
  'notifications.ping_unavailable',
  'notifications.open_action',
  'notifications.dismiss_action',
] as const;

describe('notification launch translation parity', () => {
  it.each(notificationLaunchKeys)('provides non-empty English and Spanish copy for %s', key => {
    expect(en[key]?.trim()).toBeTruthy();
    expect(es[key]?.trim()).toBeTruthy();
    expect(es[key]).not.toBe(en[key]);
  });
});
