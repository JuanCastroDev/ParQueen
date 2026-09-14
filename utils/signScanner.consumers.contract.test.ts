import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8');

describe('sign scanner consumers use the shared abstraction', () => {
  it('AssistantView does not import Capacitor Camera or branch on platform itself', () => {
    const source = read('../views/AssistantView.tsx');
    expect(source).not.toMatch(/from '@capacitor\/camera'/);
    expect(source).not.toMatch(/from '@capacitor\/app'/);
    expect(source).not.toMatch(/Capacitor\.(isNativePlatform|getPlatform)/);
    expect(source).toMatch(/from ['"].*utils\/signScanner['"]/);
  });

  it('native adapter never logs image or base64 contents', () => {
    const source = read('./signScanner.ts');
    expect(source).not.toMatch(/console\.(log|info|debug|error).*imageData/);
    expect(source).not.toMatch(/console\.(log|info|debug|error).*base64/);
    expect(source).not.toMatch(/console\.(log|info|debug|error).*previewUrl/);
    expect(source).toMatch(/saveToGallery:\s*false/);
  });

  it('does not add broad storage or background-location permissions', () => {
    const manifest = read('../android/app/src/main/AndroidManifest.xml');
    expect(manifest).not.toMatch(/uses-permission[^>]*READ_EXTERNAL_STORAGE/);
    expect(manifest).not.toMatch(/uses-permission[^>]*WRITE_EXTERNAL_STORAGE/);
    expect(manifest).not.toMatch(/uses-permission[^>]*READ_MEDIA_IMAGES/);
    expect(manifest).not.toMatch(/uses-permission[^>]*ACCESS_BACKGROUND_LOCATION/);
  });

  it('narrows FileProvider paths away from shared external storage', () => {
    const paths = read('../android/app/src/main/res/xml/file_paths.xml');
    expect(paths).not.toMatch(/<external-path\b/);
    expect(paths).toMatch(/<cache-path\b/);
    expect(paths).toMatch(/<external-files-path\b/);
    expect(paths).toMatch(/path="Pictures\/"/);
  });
});
