import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8');

describe('camera-only sign scanner packaging', () => {
  it('removes the Capacitor camera plugin from npm and native registration', () => {
    const pkg = read('../package.json');
    const lock = read('../package-lock.json');
    const iosPackage = read('../ios/App/CapApp-SPM/Package.swift');
    const gradle = read('../android/app/capacitor.build.gradle');
    const settings = read('../android/capacitor.settings.gradle');
    expect(pkg).not.toMatch(/"@capacitor\/camera"/);
    expect(lock).not.toMatch(/node_modules\/@capacitor\/camera/);
    expect(iosPackage).not.toMatch(/CapacitorCamera/);
    expect(gradle).not.toMatch(/capacitor-camera/);
    expect(settings).not.toMatch(/capacitor-camera/);
    expect(settings).not.toMatch(/@capacitor\/camera/);
  });

  it('keeps the sign scanner on camera capture and off the photo library', () => {
    const scanner = read('./signScanner.ts');
    const view = read('../views/AssistantView.tsx');
    const plist = read('../ios/App/App/Info.plist');
    expect(scanner).not.toMatch(/chooseFromGallery|pickFromGallery/);
    expect(view).not.toMatch(/chooseFromGallery|pickFromGallery/);
    expect(plist).toMatch(/<key>NSCameraUsageDescription<\/key>\s*<string>[^<]+<\/string>/);
    expect(plist).not.toMatch(/NSPhotoLibraryUsageDescription/);
    expect(plist).not.toMatch(/NSPhotoLibraryAddUsageDescription/);
  });
});
