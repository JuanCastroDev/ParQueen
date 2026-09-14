import { App } from '@capacitor/app';
import {
  Camera,
  CameraDirection,
  CameraErrorCode,
  EncodingType,
  MediaTypeSelection,
} from '@capacitor/camera';
import { resolveSignScannerPath, type SignScannerPath } from './signScannerPlatform';

/** Previewable image + raw base64 for `analyzeParkingSign()`. */
export interface SignImage {
  previewUrl: string;
  imageData: string;
}

export type SignCaptureOutcome =
  | { status: 'captured'; image: SignImage }
  | { status: 'cancelled' }
  | { status: 'empty' };

export interface NativeMediaResult {
  webPath?: string;
  thumbnail?: string;
  uri?: string;
  dataUrl?: string;
  base64String?: string;
  format?: string;
  metadata?: { format?: string };
}

export interface NativeCameraPlugin {
  takePhoto: (options: {
    quality?: number;
    saveToGallery?: boolean;
    editable?: 'in-app' | 'external' | 'no';
    correctOrientation?: boolean;
    encodingType?: EncodingType;
    cameraDirection?: CameraDirection;
  }) => Promise<NativeMediaResult>;
  chooseFromGallery: (options: {
    mediaType?: MediaTypeSelection;
    allowMultipleSelection?: boolean;
    quality?: number;
    includeMetadata?: boolean;
  }) => Promise<{ results?: NativeMediaResult[] }>;
}

export interface RestoredPluginResult {
  pluginId: string;
  methodName: string;
  success: boolean;
  data?: unknown;
  error?: { message?: string; code?: string };
}

export interface NativeAppPlugin {
  addListener: (
    eventName: 'appRestoredResult',
    listener: (event: RestoredPluginResult) => void,
  ) => Promise<{ remove: () => Promise<void> }>;
}

export interface SignScannerBackend {
  path: SignScannerPath;
  captureFromCamera: () => Promise<SignCaptureOutcome>;
  pickFromGallery: () => Promise<SignCaptureOutcome>;
}

export interface SignScannerFetch {
  (input: string): Promise<{ ok: boolean; blob: () => Promise<Blob> }>;
}

const DATA_URL_RE = /^data:([^;,]+);base64,(.+)$/s;

const CANCELLED_CODES = new Set<string>([
  CameraErrorCode.TakePhotoCancelled,
  CameraErrorCode.ChooseMediaCancelled,
  CameraErrorCode.EditPhotoCancelled,
]);

const NATIVE_TAKE_OPTIONS = {
  quality: 90,
  saveToGallery: false,
  editable: 'no' as const,
  correctOrientation: true,
  encodingType: EncodingType.JPEG,
  cameraDirection: CameraDirection.Rear,
};

const NATIVE_GALLERY_OPTIONS = {
  mediaType: MediaTypeSelection.Photo,
  allowMultipleSelection: false,
  quality: 90,
  includeMetadata: false,
};

export const nativeErrorCode = (error: unknown): string => {
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object') {
    const rec = error as { code?: unknown; message?: unknown };
    if (rec.code != null && String(rec.code).trim() !== '') return String(rec.code);
    if (rec.message != null) return String(rec.message);
  }
  return '';
};

export const isUserCancelledCapture = (error: unknown): boolean => {
  const raw = nativeErrorCode(error);
  if (!raw) return false;
  if (CANCELLED_CODES.has(raw)) return true;
  if (/OS-PLUG-CAMR-0006|OS-PLUG-CAMR-0020|OS-PLUG-CAMR-0013/.test(raw)) return true;
  if (/User cancelled photos app/i.test(raw)) return true;
  return /cancel/i.test(raw);
};

export const signImageFromDataUrl = (dataUrl: string): SignImage | null => {
  const match = DATA_URL_RE.exec((dataUrl || '').trim());
  if (!match || !match[2]) return null;
  return { previewUrl: `data:${match[1]};base64,${match[2]}`, imageData: match[2] };
};

export const signImageFromBase64 = (base64: string, mime = 'image/jpeg'): SignImage | null => {
  const imageData = (base64 || '').trim();
  if (!imageData) return null;
  if (imageData.startsWith('data:')) return signImageFromDataUrl(imageData);
  const safeMime = mime && mime.startsWith('image/') ? mime : 'image/jpeg';
  return { previewUrl: `data:${safeMime};base64,${imageData}`, imageData };
};

const mimeFromFormat = (format: string | undefined): string => {
  if (!format) return 'image/jpeg';
  const trimmed = format.trim().toLowerCase();
  if (trimmed.startsWith('image/')) return trimmed;
  if (/^[a-z0-9.+-]+$/.test(trimmed)) return `image/${trimmed}`;
  return 'image/jpeg';
};

const bytesToBase64 = (bytes: Uint8Array): string => {
  let binary = '';
  const chunk = 0x2000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
};

export const blobToSignImage = async (blob: Blob | null | undefined): Promise<SignImage | null> => {
  if (!blob || blob.size === 0) return null;
  const buffer = await blob.arrayBuffer();
  if (buffer.byteLength === 0) return null;
  const imageData = bytesToBase64(new Uint8Array(buffer));
  if (!imageData) return null;
  const mime = blob.type && blob.type.startsWith('image/') ? blob.type : 'image/jpeg';
  return { previewUrl: `data:${mime};base64,${imageData}`, imageData };
};

export const mediaResultToSignImage = async (
  result: NativeMediaResult | null | undefined,
  fetchImpl: SignScannerFetch = fetch,
): Promise<SignImage | null> => {
  if (!result) return null;
  if (typeof result.dataUrl === 'string') {
    const fromDataUrl = signImageFromDataUrl(result.dataUrl);
    if (fromDataUrl) return fromDataUrl;
  }
  if (typeof result.base64String === 'string') {
    const fromLegacy = signImageFromBase64(result.base64String, mimeFromFormat(result.format));
    if (fromLegacy) return fromLegacy;
  }
  if (result.webPath) {
    try {
      const response = await fetchImpl(result.webPath);
      if (response.ok) {
        const fromBlob = await blobToSignImage(await response.blob());
        if (fromBlob) return fromBlob;
      }
    } catch {
      // Fall through to thumbnail. Never log image / base64 contents.
    }
  }
  if (typeof result.thumbnail === 'string' && result.thumbnail.trim()) {
    return signImageFromBase64(result.thumbnail, mimeFromFormat(result.metadata?.format || result.format));
  }
  return null;
};

const firstGalleryResult = (data: unknown): NativeMediaResult | null => {
  if (!data || typeof data !== 'object') return null;
  const results = (data as { results?: unknown }).results;
  if (!Array.isArray(results) || results.length === 0) return null;
  const first = results[0];
  return first && typeof first === 'object' ? first as NativeMediaResult : null;
};

export const restoredEventToOutcome = async (
  event: RestoredPluginResult,
  fetchImpl: SignScannerFetch = fetch,
): Promise<SignCaptureOutcome | null> => {
  if (event.pluginId !== 'Camera') return null;
  const method = event.methodName;
  if (method !== 'takePhoto' && method !== 'chooseFromGallery' && method !== 'getPhoto') {
    return null;
  }
  if (!event.success) {
    return isUserCancelledCapture(event.error) ? { status: 'cancelled' } : { status: 'empty' };
  }
  const media = method === 'chooseFromGallery'
    ? firstGalleryResult(event.data)
    : (event.data && typeof event.data === 'object' ? event.data as NativeMediaResult : null);
  const image = await mediaResultToSignImage(media, fetchImpl);
  return image ? { status: 'captured', image } : { status: 'empty' };
};

const wrapNativeCall = async (
  run: () => Promise<SignImage | null>,
): Promise<SignCaptureOutcome> => {
  try {
    const image = await run();
    return image ? { status: 'captured', image } : { status: 'empty' };
  } catch (error) {
    if (isUserCancelledCapture(error)) return { status: 'cancelled' };
    return { status: 'empty' };
  }
};

export const createNativeSignScanner = (
  plugin: NativeCameraPlugin,
  fetchImpl: SignScannerFetch = fetch,
): SignScannerBackend => ({
  path: 'native',
  captureFromCamera: () => wrapNativeCall(async () => (
    mediaResultToSignImage(await plugin.takePhoto(NATIVE_TAKE_OPTIONS), fetchImpl)
  )),
  pickFromGallery: () => wrapNativeCall(async () => {
    const { results } = await plugin.chooseFromGallery(NATIVE_GALLERY_OPTIONS);
    if (!results || results.length === 0) return null;
    return mediaResultToSignImage(results[0], fetchImpl);
  }),
});

export const createBrowserSignScanner = (): SignScannerBackend => ({
  path: 'browser',
  async captureFromCamera() {
    return { status: 'empty' };
  },
  async pickFromGallery() {
    return { status: 'empty' };
  },
});

export const createParQueenSignScanner = (
  path: SignScannerPath = resolveSignScannerPath(),
  nativePlugin: NativeCameraPlugin = Camera,
  fetchImpl: SignScannerFetch = fetch,
): SignScannerBackend => (
  path === 'native' ? createNativeSignScanner(nativePlugin, fetchImpl) : createBrowserSignScanner()
);

let backend: SignScannerBackend = createParQueenSignScanner();
let restoreStarted = false;
let pendingRestored: SignCaptureOutcome | null = null;
const restoredListeners = new Set<(outcome: SignCaptureOutcome) => void>();

const deliverRestored = (outcome: SignCaptureOutcome): void => {
  if (outcome.status === 'cancelled') return;
  if (restoredListeners.size === 0) {
    pendingRestored = outcome.status === 'captured' ? outcome : null;
    return;
  }
  pendingRestored = null;
  restoredListeners.forEach((listener) => listener(outcome));
};

export const initSignScannerRestore = (
  path: SignScannerPath = resolveSignScannerPath(),
  appPlugin: NativeAppPlugin = App,
  fetchImpl: SignScannerFetch = fetch,
): void => {
  if (restoreStarted) return;
  restoreStarted = true;
  if (path !== 'native') return;
  void appPlugin.addListener('appRestoredResult', (event) => {
    void restoredEventToOutcome(event, fetchImpl).then((outcome) => {
      if (outcome) deliverRestored(outcome);
    });
  });
};

export const subscribeRestoredSignCapture = (
  listener: (outcome: SignCaptureOutcome) => void,
): (() => void) => {
  restoredListeners.add(listener);
  if (pendingRestored) {
    const next = pendingRestored;
    pendingRestored = null;
    listener(next);
  }
  return () => {
    restoredListeners.delete(listener);
  };
};

/** Test-only: replace the process-wide backend / restore buffer. */
export const __setSignScannerForTests = (next?: SignScannerBackend): void => {
  backend = next ?? createParQueenSignScanner();
};

export const __resetSignScannerRestoreForTests = (): void => {
  restoreStarted = false;
  pendingRestored = null;
  restoredListeners.clear();
};

export const getSignScanner = (): SignScannerBackend => backend;

export const usesNativeSignCapture = (): boolean => backend.path === 'native';

export const captureFromCamera = (): Promise<SignCaptureOutcome> => backend.captureFromCamera();

export const pickFromGallery = (): Promise<SignCaptureOutcome> => backend.pickFromGallery();
