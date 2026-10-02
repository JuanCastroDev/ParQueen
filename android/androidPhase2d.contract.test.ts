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

  it('keeps FileProvider for the WebView camera capture file only', () => {
    const manifest = read('./app/src/main/AndroidManifest.xml');
    const paths = read('./app/src/main/res/xml/file_paths.xml');
    expect(manifest).toMatch(/androidx.core.content.FileProvider/);
    expect(manifest).toMatch(/@xml\/file_paths/);
    expect(paths).not.toMatch(/<external-path\b/);
    expect(paths).not.toMatch(/<cache-path\b/);
    expect(paths).toMatch(/<external-files-path\b/);
    expect(paths).toMatch(/path="Pictures\/"/);
  });

  it('does not wire the Capacitor camera plugin into the Android project', () => {
    const capBuild = read('./app/capacitor.build.gradle');
    const settings = read('./capacitor.settings.gradle');
    expect(capBuild).not.toContain("implementation project(':capacitor-camera')");
    expect(settings).not.toContain("include ':capacitor-camera'");
    expect(settings).not.toContain('@capacitor/camera/android');
    expect(capBuild).toContain("implementation project(':capacitor-app')");
    expect(settings).toContain("include ':capacitor-app'");
    expect(settings).toContain('@capacitor/app/android');
  });
});
