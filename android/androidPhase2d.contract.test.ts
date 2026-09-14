import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');

describe('Android Phase 2D camera contracts', () => {
  it('does not add camera, media, storage, or background-location permissions', () => {
    const manifest = read('./app/src/main/AndroidManifest.xml');
    expect(manifest).not.toMatch(/uses-permission[^>]*android.permission.CAMERA/);
    expect(manifest).not.toMatch(/uses-permission[^>]*READ_EXTERNAL_STORAGE/);
    expect(manifest).not.toMatch(/uses-permission[^>]*WRITE_EXTERNAL_STORAGE/);
    expect(manifest).not.toMatch(/uses-permission[^>]*READ_MEDIA_IMAGES/);
    expect(manifest).not.toMatch(/uses-permission[^>]*ACCESS_BACKGROUND_LOCATION/);
  });

  it('keeps FileProvider on app-private cache and Pictures paths only', () => {
    const paths = read('./app/src/main/res/xml/file_paths.xml');
    expect(paths).not.toMatch(/<external-path\b/);
    expect(paths).toMatch(/<cache-path\b/);
    expect(paths).toMatch(/<external-files-path\b/);
    expect(paths).toMatch(/path="Pictures\/"/);
  });

  it('wires the official Capacitor camera and app modules into the Android project', () => {
    const capBuild = read('./app/capacitor.build.gradle');
    const settings = read('./capacitor.settings.gradle');
    expect(capBuild).toContain("implementation project(':capacitor-camera')");
    expect(capBuild).toContain("implementation project(':capacitor-app')");
    expect(settings).toContain("include ':capacitor-camera'");
    expect(settings).toContain('@capacitor/camera/android');
    expect(settings).toContain("include ':capacitor-app'");
    expect(settings).toContain('@capacitor/app/android');
  });
});
