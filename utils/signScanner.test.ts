import { describe, expect, it } from 'vitest';
import { fileToSignImage, signImageFromBase64, signImageFromDataUrl } from './signScanner';

describe('camera file capture', () => {
  it('converts a selected camera file into preview and analyze data', async () => {
    const bytes = Uint8Array.from([1, 2, 3, 4]);
    const file = new Blob([bytes], { type: 'image/jpeg' });
    const image = await fileToSignImage(file);
    expect(image).not.toBeNull();
    expect(image?.previewUrl.startsWith('data:image/jpeg;base64,')).toBe(true);
    expect(image?.imageData).toBe(btoa(String.fromCharCode(...bytes)));
    expect(image?.previewUrl.endsWith(image?.imageData ?? '')).toBe(true);
  });

  it('rejects an empty camera file', async () => {
    expect(await fileToSignImage(new Blob([], { type: 'image/jpeg' }))).toBeNull();
    expect(await fileToSignImage(null)).toBeNull();
  });

  it('keeps a data URL and raw base64 readable for preview', () => {
    expect(signImageFromDataUrl('data:image/png;base64,abc')).toEqual({
      previewUrl: 'data:image/png;base64,abc',
      imageData: 'abc',
    });
    expect(signImageFromBase64('abc', 'image/jpeg')?.imageData).toBe('abc');
    expect(signImageFromDataUrl('not-an-image')).toBeNull();
  });
});
