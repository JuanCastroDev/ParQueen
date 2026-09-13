import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  POSITION_PERMISSION_DENIED,
  POSITION_TIMEOUT,
  POSITION_UNAVAILABLE,
  __setLocationBackendForTests,
  checkLocationPermission,
  createBrowserGeolocation,
  createNativeGeolocation,
  createParQueenGeolocation,
  getCurrentPosition,
  isLocationServicesDisabledError,
  mapBrowserPositionError,
  mapNativePositionError,
  mapPluginPermissionStatus,
  normalizePosition,
  requestLocationPermission,
  watchPosition,
  type NativeGeolocationPlugin,
} from './geolocation';

const sampleCoords = { latitude: 40.7128, longitude: -74.006, accuracy: 12 };

const makeNativePlugin = (overrides: Partial<NativeGeolocationPlugin> = {}): NativeGeolocationPlugin => ({
  getCurrentPosition: vi.fn(async () => ({ coords: sampleCoords })),
  watchPosition: vi.fn(async (_options, callback) => {
    callback({ coords: sampleCoords });
    return 'watch-1';
  }),
  clearWatch: vi.fn(async () => undefined),
  checkPermissions: vi.fn(async () => ({ location: 'prompt', coarseLocation: 'prompt' })),
  requestPermissions: vi.fn(async () => ({ location: 'granted', coarseLocation: 'granted' })),
  ...overrides,
});

afterEach(() => {
  __setLocationBackendForTests();
});

describe('normalizePosition', () => {
  it('keeps the latitude / longitude / accuracy shape consumers already use', () => {
    expect(normalizePosition({ coords: sampleCoords })).toEqual({
      coords: { latitude: 40.7128, longitude: -74.006, accuracy: 12 },
    });
  });

  it('does not copy extra coordinate fields into the app position', () => {
    const normalized = normalizePosition({
      coords: { ...sampleCoords, altitude: 10, heading: 90 } as typeof sampleCoords & { altitude: number; heading: number },
    });
    expect(normalized.coords).toEqual({ latitude: 40.7128, longitude: -74.006, accuracy: 12 });
    expect(normalized).not.toHaveProperty('coords.altitude');
  });
});

describe('mapPluginPermissionStatus', () => {
  it('treats precise (fine) grants as granted', () => {
    const snap = mapPluginPermissionStatus({ location: 'granted', coarseLocation: 'granted' }, true);
    expect(snap).toMatchObject({ status: 'granted', accuracy: 'precise', precise: true, approximate: true });
  });

  it('treats Android approximate / coarse-only grants as usable granted', () => {
    const snap = mapPluginPermissionStatus({ location: 'denied', coarseLocation: 'granted' }, true);
    expect(snap).toMatchObject({ status: 'granted', accuracy: 'approximate', precise: false, approximate: true });
  });

  it('maps a full denial', () => {
    expect(mapPluginPermissionStatus({ location: 'denied', coarseLocation: 'denied' }, true).status).toBe('denied');
  });

  it('maps prompt and prompt-with-rationale as not-yet-requested', () => {
    expect(mapPluginPermissionStatus({ location: 'prompt', coarseLocation: 'prompt' }, true).status).toBe('prompt');
    expect(mapPluginPermissionStatus({ location: 'prompt-with-rationale', coarseLocation: 'prompt' }, true).status).toBe('prompt');
  });
});

describe('native error mapping', () => {
  it('detects location services disabled without treating it as a permission denial', () => {
    expect(isLocationServicesDisabledError({ code: 'OS-PLUG-GLOC-0007' })).toBe(true);
    const error = mapNativePositionError({ code: 'OS-PLUG-GLOC-0007' });
    expect(error.kind).toBe('services_disabled');
    expect(error.code).toBe(POSITION_UNAVAILABLE);
  });

  it('maps permission, timeout, and unavailable native codes', () => {
    expect(mapNativePositionError({ code: 'OS-PLUG-GLOC-0003' }).kind).toBe('permission');
    expect(mapNativePositionError({ code: 'OS-PLUG-GLOC-0003' }).code).toBe(POSITION_PERMISSION_DENIED);
    expect(mapNativePositionError({ code: 'OS-PLUG-GLOC-0010' }).kind).toBe('timeout');
    expect(mapNativePositionError({ code: 'OS-PLUG-GLOC-0010' }).code).toBe(POSITION_TIMEOUT);
    expect(mapNativePositionError({ code: 'OS-PLUG-GLOC-0002' }).kind).toBe('unavailable');
  });

  it('preserves browser-shaped numeric codes', () => {
    expect(mapBrowserPositionError({ code: 1 }).kind).toBe('permission');
    expect(mapBrowserPositionError({ code: 3 }).kind).toBe('timeout');
    expect(mapBrowserPositionError({ code: 2 }).kind).toBe('unavailable');
  });
});

describe('native getCurrentPosition / watchPosition', () => {
  it('returns the shared coordinate shape from the Capacitor plugin', async () => {
    const plugin = makeNativePlugin();
    const backend = createNativeGeolocation(plugin);
    await expect(backend.getCurrentPosition({ enableHighAccuracy: true })).resolves.toEqual({
      coords: { latitude: 40.7128, longitude: -74.006, accuracy: 12 },
    });
    expect(plugin.getCurrentPosition).toHaveBeenCalledWith({ enableHighAccuracy: true });
  });

  it('maps a native timeout to a transient position error', async () => {
    const plugin = makeNativePlugin({
      getCurrentPosition: vi.fn(async () => { throw { code: 'OS-PLUG-GLOC-0010' }; }),
    });
    await expect(createNativeGeolocation(plugin).getCurrentPosition()).rejects.toMatchObject({
      kind: 'timeout',
      code: POSITION_TIMEOUT,
    });
  });

  it('starts a native watch and clears it, including if clear races the watch id', async () => {
    let send: ((position: { coords: typeof sampleCoords } | null, err?: unknown) => void) | undefined;
    let resolveId: ((id: string) => void) | undefined;
    const plugin = makeNativePlugin({
      watchPosition: vi.fn((_options, callback) => {
        send = callback;
        return new Promise<string>((resolve) => { resolveId = resolve; });
      }),
    });
    const updates: number[] = [];
    const handle = createNativeGeolocation(plugin).watchPosition((pos) => updates.push(pos.coords.latitude));
    handle.clear();
    resolveId?.('watch-late');
    await Promise.resolve();
    send?.({ coords: sampleCoords });
    expect(updates).toEqual([]);
    expect(plugin.clearWatch).toHaveBeenCalledWith({ id: 'watch-late' });
  });

  it('delivers watch updates then clearWatch on cleanup', async () => {
    const plugin = makeNativePlugin();
    const seen: number[] = [];
    const handle = createNativeGeolocation(plugin).watchPosition((pos) => seen.push(pos.coords.latitude));
    await Promise.resolve();
    handle.clear();
    expect(seen).toEqual([40.7128]);
    expect(plugin.clearWatch).toHaveBeenCalledWith({ id: 'watch-1' });
  });
});

describe('native permission request does not re-prompt', () => {
  it('returns an existing grant without calling requestPermissions', async () => {
    const plugin = makeNativePlugin({
      checkPermissions: vi.fn(async () => ({ location: 'granted', coarseLocation: 'granted' })),
    });
    const snap = await createNativeGeolocation(plugin).requestPermission();
    expect(snap.status).toBe('granted');
    expect(plugin.requestPermissions).not.toHaveBeenCalled();
  });

  it('returns an existing denial without calling requestPermissions', async () => {
    const plugin = makeNativePlugin({
      checkPermissions: vi.fn(async () => ({ location: 'denied', coarseLocation: 'denied' })),
    });
    const snap = await createNativeGeolocation(plugin).requestPermission();
    expect(snap.status).toBe('denied');
    expect(plugin.requestPermissions).not.toHaveBeenCalled();
  });

  it('requests only when the OS state is still prompt', async () => {
    const plugin = makeNativePlugin();
    const snap = await createNativeGeolocation(plugin).requestPermission();
    expect(plugin.requestPermissions).toHaveBeenCalledWith({ permissions: ['location'] });
    expect(snap.status).toBe('granted');
  });

  it('does not persist-style deny when location services are off', async () => {
    const plugin = makeNativePlugin({
      checkPermissions: vi.fn(async () => { throw { code: 'OS-PLUG-GLOC-0007' }; }),
    });
    const snap = await createNativeGeolocation(plugin).requestPermission();
    expect(snap.locationServicesEnabled).toBe(false);
    expect(snap.status).toBe('unavailable');
    expect(plugin.requestPermissions).not.toHaveBeenCalled();
  });
});

describe('browser / PWA fallback', () => {
  it('delegates getCurrentPosition to navigator.geolocation', async () => {
    const getCurrent = vi.fn((success: (pos: { coords: typeof sampleCoords }) => void) => {
      success({ coords: sampleCoords });
    });
    const backend = createBrowserGeolocation({
      getGeolocation: () => ({
        getCurrentPosition: getCurrent,
        watchPosition: vi.fn(),
        clearWatch: vi.fn(),
      }) as unknown as Geolocation,
    });
    await expect(backend.getCurrentPosition({ timeout: 8000 })).resolves.toEqual({
      coords: { latitude: 40.7128, longitude: -74.006, accuracy: 12 },
    });
    expect(getCurrent).toHaveBeenCalled();
  });

  it('watchPosition + clearWatch use the browser ids', () => {
    const clearWatch = vi.fn();
    const watchPositionFn = vi.fn(() => 42);
    const backend = createBrowserGeolocation({
      getGeolocation: () => ({
        getCurrentPosition: vi.fn(),
        watchPosition: watchPositionFn,
        clearWatch,
      }) as unknown as Geolocation,
    });
    const handle = backend.watchPosition(() => undefined);
    handle.clear();
    expect(watchPositionFn).toHaveBeenCalledOnce();
    expect(clearWatch).toHaveBeenCalledWith(42);
  });

  it('does not treat a browser timeout as a permanent denial', async () => {
    const backend = createBrowserGeolocation({
      getGeolocation: () => ({
        getCurrentPosition: (_success: unknown, error: (err: { code: number }) => void) => {
          error({ code: POSITION_TIMEOUT });
        },
        watchPosition: vi.fn(),
        clearWatch: vi.fn(),
      }) as unknown as Geolocation,
      queryPermission: async () => 'prompt',
    });
    const snap = await backend.requestPermission();
    expect(snap.status).toBe('prompt');
  });

  it('maps an explicit browser permission denial', async () => {
    const backend = createBrowserGeolocation({
      getGeolocation: () => ({
        getCurrentPosition: (_success: unknown, error: (err: { code: number }) => void) => {
          error({ code: POSITION_PERMISSION_DENIED });
        },
        watchPosition: vi.fn(),
        clearWatch: vi.fn(),
      }) as unknown as Geolocation,
      queryPermission: async () => 'prompt',
    });
    await expect(backend.requestPermission()).resolves.toMatchObject({ status: 'denied' });
  });

  it('skips the OS-style prompt when the Permissions API already says granted', async () => {
    const getCurrent = vi.fn();
    const backend = createBrowserGeolocation({
      getGeolocation: () => ({
        getCurrentPosition: getCurrent,
        watchPosition: vi.fn(),
        clearWatch: vi.fn(),
      }) as unknown as Geolocation,
      queryPermission: async () => 'granted',
    });
    await expect(backend.requestPermission()).resolves.toMatchObject({ status: 'granted' });
    expect(getCurrent).not.toHaveBeenCalled();
  });
});

describe('createParQueenGeolocation platform selection', () => {
  it('uses the native backend on Android', async () => {
    const plugin = makeNativePlugin();
    const backend = createParQueenGeolocation('native', plugin);
    expect(backend.path).toBe('native');
    await backend.getCurrentPosition();
    expect(plugin.getCurrentPosition).toHaveBeenCalled();
  });

  it('uses the browser backend on web / iOS', async () => {
    const plugin = makeNativePlugin();
    const getCurrent = vi.fn((success: (pos: { coords: typeof sampleCoords }) => void) => {
      success({ coords: sampleCoords });
    });
    const backend = createParQueenGeolocation('browser', plugin, {
      getGeolocation: () => ({
        getCurrentPosition: getCurrent,
        watchPosition: vi.fn(),
        clearWatch: vi.fn(),
      }) as unknown as Geolocation,
    });
    expect(backend.path).toBe('browser');
    await backend.getCurrentPosition();
    expect(plugin.getCurrentPosition).not.toHaveBeenCalled();
    expect(getCurrent).toHaveBeenCalled();
  });
});

describe('singleton facade', () => {
  it('routes getCurrentPosition / watch / permission through the injected backend', async () => {
    const plugin = makeNativePlugin();
    __setLocationBackendForTests(createNativeGeolocation(plugin));
    await expect(getCurrentPosition()).resolves.toMatchObject({ coords: { latitude: 40.7128 } });
    const handle = watchPosition(() => undefined);
    handle.clear();
    await expect(checkLocationPermission()).resolves.toMatchObject({ status: 'prompt' });
    await expect(requestLocationPermission()).resolves.toMatchObject({ status: 'granted' });
  });
});
