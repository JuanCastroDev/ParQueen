import { afterEach, describe, expect, it, vi } from 'vitest';
import { CameraErrorCode, CameraDirection, EncodingType, MediaTypeSelection } from '@capacitor/camera';
import {
  __resetSignScannerRestoreForTests,
  __setSignScannerForTests,
  blobToSignImage,
  captureFromCamera,
  createBrowserSignScanner,
  createNativeSignScanner,
  createParQueenSignScanner,
  initSignScannerRestore,
  isUserCancelledCapture,
  mediaResultToSignImage,
  pickFromGallery,
  restoredEventToOutcome,
  signImageFromBase64,
  signImageFromDataUrl,
  subscribeRestoredSignCapture,
  usesNativeSignCapture,
  type NativeAppPlugin,
  type NativeCameraPlugin,
  type NativeMediaResult,
} from './signScanner';

const PNG_BASE64 = 'aW1hZ2U=';
const PNG_DATA_URL = `data:image/png;base64,${PNG_BASE64}`;

const makeFetch = (blob: Blob, ok = true) => vi.fn(async () => ({
  ok,
  blob: async () => blob,
}));

const makePlugin = (overrides: Partial<NativeCameraPlugin> = {}): NativeCameraPlugin => ({
  takePhoto: vi.fn(async () => ({ webPath: 'https://localhost/_capacitor_file_/cam.jpg' })),
  chooseFromGallery: vi.fn(async () => ({
    results: [{ webPath: 'https://localhost/_capacitor_file_/gallery.jpg' }],
  })),
  ...overrides,
});

afterEach(() => {
  __setSignScannerForTests();
  __resetSignScannerRestoreForTests();
});

describe('sign image conversion', () => {
  it('splits a data URL into preview + raw base64 for analyzeParkingSign', () => {
    expect(signImageFromDataUrl(PNG_DATA_URL)).toEqual({
      previewUrl: PNG_DATA_URL,
      imageData: PNG_BASE64,
    });
  });

  it('rejects empty or malformed data URLs', () => {
    expect(signImageFromDataUrl('')).toBeNull();
    expect(signImageFromDataUrl('not-an-image')).toBeNull();
    expect(signImageFromDataUrl('data:image/png;base64,')).toBeNull();
  });

  it('wraps raw base64 in a previewable data URL', () => {
    expect(signImageFromBase64(PNG_BASE64, 'image/jpeg')).toEqual({
      previewUrl: `data:image/jpeg;base64,${PNG_BASE64}`,
      imageData: PNG_BASE64,
    });
  });

  it('converts a blob into the existing scanner contract', async () => {
    const blob = new Blob([Uint8Array.from([1, 2, 3, 4])], { type: 'image/jpeg' });
    const image = await blobToSignImage(blob);
    expect(image?.previewUrl.startsWith('data:image/jpeg;base64,')).toBe(true);
    expect(image?.imageData).toBeTruthy();
    expect(image?.previewUrl.endsWith(image!.imageData)).toBe(true);
  });

  it('rejects empty blobs', async () => {
    expect(await blobToSignImage(new Blob([]))).toBeNull();
  });
});

describe('mediaResultToSignImage', () => {
  it('prefers a full-resolution webPath fetch over the thumbnail', async () => {
    const blob = new Blob([Uint8Array.from([9, 8, 7])], { type: 'image/jpeg' });
    const fetchImpl = makeFetch(blob);
    const image = await mediaResultToSignImage(
      { webPath: 'capacitor://localhost/cam.jpg', thumbnail: 'thumb' },
      fetchImpl,
    );
    expect(fetchImpl).toHaveBeenCalledWith('capacitor://localhost/cam.jpg');
    expect(image?.imageData).not.toBe('thumb');
    expect(image?.previewUrl.startsWith('data:image/jpeg;base64,')).toBe(true);
  });

  it('falls back to thumbnail when webPath is missing', async () => {
    const image = await mediaResultToSignImage(
      { thumbnail: PNG_BASE64, metadata: { format: 'png' } },
      makeFetch(new Blob()),
    );
    expect(image).toEqual({
      previewUrl: PNG_DATA_URL,
      imageData: PNG_BASE64,
    });
  });

  it('returns null for an empty native result', async () => {
    expect(await mediaResultToSignImage({}, makeFetch(new Blob()))).toBeNull();
    expect(await mediaResultToSignImage(null)).toBeNull();
    expect(await mediaResultToSignImage({ webPath: '', thumbnail: '' })).toBeNull();
  });

  it('falls back to thumbnail when webPath fetch fails', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('network');
    });
    const image = await mediaResultToSignImage(
      { webPath: 'capacitor://localhost/cam.jpg', thumbnail: PNG_BASE64 },
      fetchImpl,
    );
    expect(image?.imageData).toBe(PNG_BASE64);
  });
});

describe('user cancellation', () => {
  it('treats camera and gallery cancel codes as harmless cancellation', () => {
    expect(isUserCancelledCapture({ code: CameraErrorCode.TakePhotoCancelled })).toBe(true);
    expect(isUserCancelledCapture({ code: CameraErrorCode.ChooseMediaCancelled })).toBe(true);
    expect(isUserCancelledCapture({ code: 'OS-PLUG-CAMR-0006' })).toBe(true);
    expect(isUserCancelledCapture({ message: 'User cancelled photos app' })).toBe(true);
  });

  it('does not treat malformed or permission errors as cancellation', () => {
    expect(isUserCancelledCapture({ code: CameraErrorCode.TakePhotoFailed })).toBe(false);
    expect(isUserCancelledCapture({ code: CameraErrorCode.CameraPermissionDenied })).toBe(false);
    expect(isUserCancelledCapture({})).toBe(false);
  });
});

describe('native camera / gallery capture', () => {
  it('converts a successful camera capture to the scanner contract and does not save to gallery', async () => {
    const blob = new Blob([Uint8Array.from([1, 2])], { type: 'image/jpeg' });
    const plugin = makePlugin();
    const scanner = createNativeSignScanner(plugin, makeFetch(blob));
    const outcome = await scanner.captureFromCamera();
    expect(outcome.status).toBe('captured');
    if (outcome.status === 'captured') {
      expect(outcome.image.previewUrl.startsWith('data:image/jpeg;base64,')).toBe(true);
      expect(outcome.image.imageData.length).toBeGreaterThan(0);
    }
    expect(plugin.takePhoto).toHaveBeenCalledWith(expect.objectContaining({
      saveToGallery: false,
      editable: 'no',
      quality: 90,
      encodingType: EncodingType.JPEG,
      cameraDirection: CameraDirection.Rear,
    }));
  });

  it('converts a successful gallery pick to the scanner contract', async () => {
    const blob = new Blob([Uint8Array.from([3, 4])], { type: 'image/png' });
    const plugin = makePlugin();
    const scanner = createNativeSignScanner(plugin, makeFetch(blob));
    const outcome = await scanner.pickFromGallery();
    expect(outcome.status).toBe('captured');
    expect(plugin.chooseFromGallery).toHaveBeenCalledWith(expect.objectContaining({
      mediaType: MediaTypeSelection.Photo,
      allowMultipleSelection: false,
    }));
  });

  it('returns cancelled when the user dismisses the camera or photo picker', async () => {
    const camera = createNativeSignScanner(makePlugin({
      takePhoto: vi.fn(async () => {
        throw { code: CameraErrorCode.TakePhotoCancelled };
      }),
    }));
    const gallery = createNativeSignScanner(makePlugin({
      chooseFromGallery: vi.fn(async () => {
        throw { code: CameraErrorCode.ChooseMediaCancelled };
      }),
    }));
    expect(await camera.captureFromCamera()).toEqual({ status: 'cancelled' });
    expect(await gallery.pickFromGallery()).toEqual({ status: 'cancelled' });
  });

  it('returns empty for malformed native results without throwing', async () => {
    const scanner = createNativeSignScanner(makePlugin({
      takePhoto: vi.fn(async () => ({})),
      chooseFromGallery: vi.fn(async () => ({ results: [] })),
    }));
    expect(await scanner.captureFromCamera()).toEqual({ status: 'empty' });
    expect(await scanner.pickFromGallery()).toEqual({ status: 'empty' });
  });
});

describe('browser fallback', () => {
  it('does not open a native camera path on the browser backend', async () => {
    const scanner = createBrowserSignScanner();
    expect(scanner.path).toBe('browser');
    expect(await scanner.captureFromCamera()).toEqual({ status: 'empty' });
    expect(await scanner.pickFromGallery()).toEqual({ status: 'empty' });
  });

  it('createParQueenSignScanner keeps the browser backend off Android', () => {
    expect(createParQueenSignScanner('browser').path).toBe('browser');
    expect(createParQueenSignScanner('native', makePlugin()).path).toBe('native');
  });
});

describe('appRestoredResult', () => {
  it('converts a restored takePhoto result into a captured sign image', async () => {
    const blob = new Blob([Uint8Array.from([5, 6])], { type: 'image/jpeg' });
    const outcome = await restoredEventToOutcome({
      pluginId: 'Camera',
      methodName: 'takePhoto',
      success: true,
      data: { webPath: 'capacitor://localhost/restored.jpg' },
    }, makeFetch(blob));
    expect(outcome?.status).toBe('captured');
  });

  it('converts a restored gallery result using the first photo', async () => {
    const blob = new Blob([Uint8Array.from([7, 8])], { type: 'image/jpeg' });
    const outcome = await restoredEventToOutcome({
      pluginId: 'Camera',
      methodName: 'chooseFromGallery',
      success: true,
      data: { results: [{ webPath: 'capacitor://localhost/pick.jpg' }] },
    }, makeFetch(blob));
    expect(outcome?.status).toBe('captured');
  });

  it('ignores restored results from other plugins', async () => {
    expect(await restoredEventToOutcome({
      pluginId: 'Geolocation',
      methodName: 'takePhoto',
      success: true,
      data: { webPath: 'x' },
    })).toBeNull();
  });

  it('treats a restored camera cancel as cancelled, not an error payload', async () => {
    expect(await restoredEventToOutcome({
      pluginId: 'Camera',
      methodName: 'takePhoto',
      success: false,
      error: { code: CameraErrorCode.TakePhotoCancelled, message: 'cancelled' },
    })).toEqual({ status: 'cancelled' });
  });

  it('buffers a restored capture until the scanner subscribes', async () => {
    const blob = new Blob([Uint8Array.from([1])], { type: 'image/jpeg' });
    let listener: ((event: { pluginId: string; methodName: string; success: boolean; data?: unknown }) => void) | undefined;
    const app: NativeAppPlugin = {
      addListener: vi.fn(async (_name, cb) => {
        listener = cb;
        return { remove: async () => undefined };
      }),
    };
    initSignScannerRestore('native', app, makeFetch(blob));
    listener?.({
      pluginId: 'Camera',
      methodName: 'takePhoto',
      success: true,
      data: { webPath: 'capacitor://localhost/late.jpg' },
    });
    await vi.waitFor(() => {
      const received: Array<{ status: string }> = [];
      const unsubscribe = subscribeRestoredSignCapture((outcome) => received.push(outcome));
      try {
        expect(received).toHaveLength(1);
        expect(received[0].status).toBe('captured');
      } finally {
        unsubscribe();
      }
    });
  });
});

describe('process-wide helpers', () => {
  it('usesNativeSignCapture follows the injected backend, not Capacitor on web tests', () => {
    expect(usesNativeSignCapture()).toBe(false);
    __setSignScannerForTests(createNativeSignScanner(makePlugin()));
    expect(usesNativeSignCapture()).toBe(true);
  });

  it('captureFromCamera / pickFromGallery delegate to the injected backend', async () => {
    const blob = new Blob([Uint8Array.from([1, 1])], { type: 'image/jpeg' });
    __setSignScannerForTests(createNativeSignScanner(makePlugin(), makeFetch(blob)));
    expect((await captureFromCamera()).status).toBe('captured');
    expect((await pickFromGallery()).status).toBe('captured');
  });
});
