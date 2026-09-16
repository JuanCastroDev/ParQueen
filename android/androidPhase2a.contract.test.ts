import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');

describe('Android Phase 2A native contracts', () => {
  it('resizes with the keyboard and does not back up authenticated WebView state', () => {
    const manifest = read('./app/src/main/AndroidManifest.xml');
    expect(manifest).toContain('android:windowSoftInputMode="adjustResize"');
    expect(manifest).not.toMatch(/windowSoftInputMode="adjust(?:Pan|Nothing)"/);
    expect(manifest).toContain('android:allowBackup="false"');
    expect(manifest).not.toContain('android:allowBackup="true"');
  });

  it('registers the narrow PhoneAuth plugin before the Capacitor bridge starts', () => {
    const activity = read('./app/src/main/java/app/parqueen/MainActivity.java');
    expect(activity).toContain('registerPlugin(PhoneAuthPlugin.class)');
    expect(activity.indexOf('registerPlugin(PhoneAuthPlugin.class)'))
      .toBeLessThan(activity.indexOf('super.onCreate(savedInstanceState)'));
  });

  it('returns verificationId to JS and does not present a native OTP dialog', () => {
    const plugin = read('./app/src/main/java/app/parqueen/PhoneAuthPlugin.java');
    expect(plugin).toContain('result.put("verificationId", verificationId)');
    expect(plugin).toContain('PhoneAuthProvider.verifyPhoneNumber');
    expect(plugin).not.toContain('AlertDialog');
    expect(plugin).not.toContain('prompt');
  });
});
