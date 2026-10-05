import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(__dirname, '..');
const read = (path: string) => readFileSync(join(root, path), 'utf8');

describe('Capacitor iOS native foreground geolocation contract', () => {
  const resolver = read('utils/geolocationPlatform.ts');
  const iosPackage = read('ios/App/CapApp-SPM/Package.swift');
  const plist = read('ios/App/App/Info.plist');

  it('routes Capacitor iOS through the native geolocation backend while Web stays browser-based', () => {
    expect(resolver).toContain("env.platform === 'android' || env.platform === 'ios'");
    expect(resolver).toContain("? 'native'");
    expect(resolver).toContain(": 'browser'");
  });

  it('keeps the official Capacitor Geolocation plugin linked into the iOS shell', () => {
    expect(iosPackage).toContain('.package(name: "CapacitorGeolocation"');
    expect(iosPackage).toContain('.product(name: "CapacitorGeolocation"');
  });

  it('declares iOS location usage copy without enabling background-location mode', () => {
    expect(plist).toMatch(/<key>NSLocationWhenInUseUsageDescription<\/key>\s*<string>[^<]+<\/string>/);
    expect(plist).toMatch(/<key>NSLocationAlwaysAndWhenInUseUsageDescription<\/key>\s*<string>[^<]+<\/string>/);
    expect(plist).not.toMatch(/<key>UIBackgroundModes<\/key>[\s\S]*?<string>location<\/string>/);
  });
});
