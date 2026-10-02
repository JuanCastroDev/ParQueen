import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8');

describe('sign scanner consumers stay camera-only', () => {
  it('AssistantView does not import Capacitor Camera or a gallery picker', () => {
    const source = read('../views/AssistantView.tsx');
    expect(source).not.toMatch(/from '@capacitor\/camera'/);
    expect(source).not.toMatch(/from '@capacitor\/app'/);
    expect(source).not.toMatch(/Capacitor\.(isNativePlatform|getPlatform)/);
    expect(source).not.toMatch(/chooseFromGallery|pickFromGallery|galleryInputRef/);
    expect(source).toMatch(/from ['"].*utils\/signScanner['"]/);
    expect(source).toMatch(/accept="image\/\*"/);
    expect(source).toMatch(/capture="environment"/);
  });

  it('scanner conversion never logs image or base64 contents', () => {
    const source = read('./signScanner.ts');
    expect(source).not.toMatch(/console\.(log|info|debug|error)/);
    expect(source).not.toMatch(/@capacitor\/camera/);
    expect(source).not.toMatch(/chooseFromGallery|pickFromGallery/);
  });

  it('does not add photo-library, storage, or background-location permissions', () => {
    const manifest = read('../android/app/src/main/AndroidManifest.xml');
    expect(manifest).not.toMatch(/uses-permission[^>]*READ_EXTERNAL_STORAGE/);
    expect(manifest).not.toMatch(/uses-permission[^>]*WRITE_EXTERNAL_STORAGE/);
    expect(manifest).not.toMatch(/uses-permission[^>]*READ_MEDIA_IMAGES/);
    expect(manifest).not.toMatch(/uses-permission[^>]*ACCESS_BACKGROUND_LOCATION/);
  });

  it('keeps profile photo selection on a user-initiated file input', () => {
    for (const rel of ['../views/ProfileView.tsx', '../views/SetupProfileView.tsx']) {
      const source = read(rel);
      expect(source).toMatch(/type="file"/);
      expect(source).toMatch(/accept="image\//);
      expect(source).not.toMatch(/@capacitor\/camera/);
      expect(source).not.toMatch(/chooseFromGallery|pickFromGallery/);
    }
  });
});
