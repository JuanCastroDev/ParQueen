import { Geolocation as CapacitorGeolocation } from '@capacitor/geolocation';
import { resolveGeolocationPath, type GeolocationPath } from './geolocationPlatform';

/** W3C / GeolocationPositionError.PERMISSION_DENIED */
export const POSITION_PERMISSION_DENIED = 1;
/** W3C / GeolocationPositionError.POSITION_UNAVAILABLE */
export const POSITION_UNAVAILABLE = 2;
/** W3C / GeolocationPositionError.TIMEOUT */
export const POSITION_TIMEOUT = 3;

export type LocationAccuracy = 'precise' | 'approximate' | 'unknown';
export type LocationPermissionStatus = 'prompt' | 'granted' | 'denied' | 'unavailable';

/**
 * OS / runtime permission snapshot. Coarse-only Android 12+ grants are
 * `granted` + `approximate` — usable for map, geohash, and distance.
 */
export interface LocationPermissionSnapshot {
  status: LocationPermissionStatus;
  accuracy: LocationAccuracy;
  precise: boolean;
  approximate: boolean;
  /** `null` on web — the Permissions API cannot detect device Location Services. */
  locationServicesEnabled: boolean | null;
}

/** Same coordinate fields ParQueen already reads from `GeolocationPosition`. */
export interface AppPosition {
  coords: {
    latitude: number;
    longitude: number;
    accuracy: number | null;
  };
}

export interface AppPositionOptions {
  enableHighAccuracy?: boolean;
  timeout?: number;
  maximumAge?: number;
}

export type LocationErrorKind = 'permission' | 'unavailable' | 'timeout' | 'services_disabled';

export class LocationPositionError extends Error {
  readonly code: number;
  readonly kind: LocationErrorKind;

  constructor(code: number, kind: LocationErrorKind, message: string) {
    super(message);
    this.name = 'LocationPositionError';
    this.code = code;
    this.kind = kind;
  }
}

export interface LocationWatchHandle {
  clear: () => void;
}

export interface LocationBackend {
  path: GeolocationPath;
  isAvailable: () => boolean;
  getCurrentPosition: (options?: AppPositionOptions) => Promise<AppPosition>;
  watchPosition: (
    onSuccess: (position: AppPosition) => void,
    onError?: (error: LocationPositionError) => void,
    options?: AppPositionOptions,
  ) => LocationWatchHandle;
  checkPermission: () => Promise<LocationPermissionSnapshot>;
  requestPermission: () => Promise<LocationPermissionSnapshot>;
}

export interface NativeGeolocationPlugin {
  getCurrentPosition: (options?: AppPositionOptions) => Promise<{
    coords: { latitude: number; longitude: number; accuracy?: number | null };
  }>;
  watchPosition: (
    options: AppPositionOptions,
    callback: (
      position: { coords: { latitude: number; longitude: number; accuracy?: number | null } } | null,
      err?: unknown,
    ) => void,
  ) => Promise<string>;
  clearWatch: (options: { id: string }) => Promise<void>;
  checkPermissions: () => Promise<{ location: string; coarseLocation?: string }>;
  requestPermissions: (permissions?: { permissions: Array<'location' | 'coarseLocation'> }) => Promise<{
    location: string;
    coarseLocation?: string;
  }>;
}

type BrowserGeolocation = Pick<Geolocation, 'getCurrentPosition' | 'watchPosition' | 'clearWatch'>;

export interface BrowserGeolocationDeps {
  getGeolocation?: () => BrowserGeolocation | undefined;
  queryPermission?: () => Promise<PermissionState | null>;
}

const emptySnapshot = (
  status: LocationPermissionStatus,
  locationServicesEnabled: boolean | null,
  accuracy: LocationAccuracy = 'unknown',
): LocationPermissionSnapshot => ({
  status,
  accuracy,
  precise: accuracy === 'precise',
  approximate: accuracy === 'precise' || accuracy === 'approximate',
  locationServicesEnabled,
});

export const normalizePosition = (position: {
  coords: { latitude: number; longitude: number; accuracy?: number | null };
}): AppPosition => ({
  coords: {
    latitude: position.coords.latitude,
    longitude: position.coords.longitude,
    accuracy: Number.isFinite(position.coords.accuracy as number)
      ? (position.coords.accuracy as number)
      : null,
  },
});

export const mapPluginPermissionStatus = (
  status: { location?: string; coarseLocation?: string },
  locationServicesEnabled: boolean,
): LocationPermissionSnapshot => {
  const fine = status.location === 'granted';
  const coarse = status.coarseLocation === 'granted' || fine;
  if (fine || coarse) {
    return {
      status: 'granted',
      accuracy: fine ? 'precise' : 'approximate',
      precise: fine,
      approximate: true,
      locationServicesEnabled,
    };
  }

  const fineDenied = status.location === 'denied';
  const coarseDenied = status.coarseLocation === 'denied' || status.coarseLocation == null;
  if (fineDenied && coarseDenied) {
    return emptySnapshot('denied', locationServicesEnabled);
  }

  return emptySnapshot('prompt', locationServicesEnabled);
};

const nativeErrorCode = (error: unknown): string => {
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object') {
    const rec = error as { code?: unknown; message?: unknown };
    if (rec.code != null) return String(rec.code);
    if (rec.message != null) return String(rec.message);
  }
  return '';
};

export const isLocationServicesDisabledError = (error: unknown): boolean => {
  const code = nativeErrorCode(error);
  return /OS-PLUG-GLOC-0007|OS-PLUG-GLOC-0017/.test(code)
    || /location services are not enabled/i.test(code)
    || /network and location turned off/i.test(code);
};

export const mapNativePositionError = (error: unknown): LocationPositionError => {
  if (error instanceof LocationPositionError) return error;
  const raw = nativeErrorCode(error);
  if (/OS-PLUG-GLOC-0003|OS-PLUG-GLOC-0008|OS-PLUG-GLOC-0009|OS-PLUG-GLOC-0018/.test(raw)) {
    return new LocationPositionError(POSITION_PERMISSION_DENIED, 'permission', 'Location permission denied');
  }
  if (isLocationServicesDisabledError(error)) {
    return new LocationPositionError(POSITION_UNAVAILABLE, 'services_disabled', 'Location services are disabled');
  }
  if (/OS-PLUG-GLOC-0010/.test(raw)) {
    return new LocationPositionError(POSITION_TIMEOUT, 'timeout', 'Location request timed out');
  }
  if (error && typeof error === 'object' && 'code' in error) {
    const numeric = Number((error as { code?: unknown }).code);
    if (numeric === POSITION_PERMISSION_DENIED) {
      return new LocationPositionError(POSITION_PERMISSION_DENIED, 'permission', 'Location permission denied');
    }
    if (numeric === POSITION_TIMEOUT) {
      return new LocationPositionError(POSITION_TIMEOUT, 'timeout', 'Location request timed out');
    }
  }
  return new LocationPositionError(POSITION_UNAVAILABLE, 'unavailable', 'Location unavailable');
};

export const mapBrowserPositionError = (error: { code?: number; message?: string } | undefined): LocationPositionError => {
  const code = error?.code ?? POSITION_UNAVAILABLE;
  if (code === POSITION_PERMISSION_DENIED) {
    return new LocationPositionError(POSITION_PERMISSION_DENIED, 'permission', error?.message || 'Location permission denied');
  }
  if (code === POSITION_TIMEOUT) {
    return new LocationPositionError(POSITION_TIMEOUT, 'timeout', error?.message || 'Location request timed out');
  }
  return new LocationPositionError(POSITION_UNAVAILABLE, 'unavailable', error?.message || 'Location unavailable');
};

const defaultQueryPermission = async (): Promise<PermissionState | null> => {
  if (typeof navigator === 'undefined' || !navigator.permissions?.query) return null;
  try {
    const result = await navigator.permissions.query({ name: 'geolocation' });
    return result.state;
  } catch {
    return null;
  }
};

const permissionFromBrowserState = (state: PermissionState | null): LocationPermissionSnapshot => {
  if (state === 'granted') return emptySnapshot('granted', null, 'precise');
  if (state === 'denied') return emptySnapshot('denied', null);
  return emptySnapshot('prompt', null);
};

export const createBrowserGeolocation = (deps: BrowserGeolocationDeps = {}): LocationBackend => {
  const getGeolocation = deps.getGeolocation ?? (() => (
    typeof navigator !== 'undefined' ? navigator.geolocation : undefined
  ));
  const queryPermission = deps.queryPermission ?? defaultQueryPermission;

  const checkPermission = async (): Promise<LocationPermissionSnapshot> => {
    if (!getGeolocation()) return emptySnapshot('denied', null);
    return permissionFromBrowserState(await queryPermission());
  };

  return {
    path: 'browser',
    isAvailable: () => !!getGeolocation(),
    async getCurrentPosition(options = {}) {
      const geo = getGeolocation();
      if (!geo) {
        throw new LocationPositionError(POSITION_PERMISSION_DENIED, 'permission', 'Geolocation is not available');
      }
      return new Promise<AppPosition>((resolve, reject) => {
        geo.getCurrentPosition(
          (position) => resolve(normalizePosition(position)),
          (error) => reject(mapBrowserPositionError(error)),
          options,
        );
      });
    },
    watchPosition(onSuccess, onError, options = {}) {
      const geo = getGeolocation();
      if (!geo) {
        onError?.(new LocationPositionError(POSITION_PERMISSION_DENIED, 'permission', 'Geolocation is not available'));
        return { clear() { /* no watch started */ } };
      }
      const id = geo.watchPosition(
        (position) => onSuccess(normalizePosition(position)),
        (error) => onError?.(mapBrowserPositionError(error)),
        options,
      );
      return {
        clear() {
          geo.clearWatch(id);
        },
      };
    },
    checkPermission,
    async requestPermission() {
      const current = await checkPermission();
      if (current.status === 'granted' || current.status === 'denied') return current;
      const geo = getGeolocation();
      if (!geo) return emptySnapshot('denied', null);
      return new Promise<LocationPermissionSnapshot>((resolve) => {
        geo.getCurrentPosition(
          () => resolve(emptySnapshot('granted', null, 'precise')),
          async (error) => {
            if (error?.code === POSITION_PERMISSION_DENIED) {
              resolve(emptySnapshot('denied', null));
              return;
            }
            // Timeout / unavailable is not a permanent denial.
            const after = await checkPermission();
            resolve(after.status === 'granted' || after.status === 'denied' ? after : emptySnapshot('prompt', null));
          },
          { enableHighAccuracy: false, timeout: 15000 },
        );
      });
    },
  };
};

export const createNativeGeolocation = (plugin: NativeGeolocationPlugin = CapacitorGeolocation): LocationBackend => {
  const checkPermission = async (): Promise<LocationPermissionSnapshot> => {
    try {
      const status = await plugin.checkPermissions();
      return mapPluginPermissionStatus(status, true);
    } catch (error) {
      if (isLocationServicesDisabledError(error)) {
        return emptySnapshot('unavailable', false);
      }
      const mapped = mapNativePositionError(error);
      if (mapped.kind === 'permission') return emptySnapshot('denied', true);
      throw mapped;
    }
  };

  return {
    path: 'native',
    isAvailable: () => true,
    async getCurrentPosition(options = {}) {
      try {
        return normalizePosition(await plugin.getCurrentPosition(options));
      } catch (error) {
        throw mapNativePositionError(error);
      }
    },
    watchPosition(onSuccess, onError, options = {}) {
      let cleared = false;
      let nativeId: string | undefined;
      plugin.watchPosition(options, (position, err) => {
        if (cleared) return;
        if (err) {
          onError?.(mapNativePositionError(err));
          return;
        }
        if (position) onSuccess(normalizePosition(position));
      }).then((id) => {
        nativeId = id;
        if (cleared) void plugin.clearWatch({ id });
      }).catch((error) => {
        if (!cleared) onError?.(mapNativePositionError(error));
      });
      return {
        clear() {
          cleared = true;
          if (nativeId) void plugin.clearWatch({ id: nativeId });
        },
      };
    },
    checkPermission,
    async requestPermission() {
      const current = await checkPermission();
      if (current.locationServicesEnabled === false) return current;
      if (current.status === 'granted' || current.status === 'denied') return current;
      try {
        const status = await plugin.requestPermissions({ permissions: ['location'] });
        return mapPluginPermissionStatus(status, true);
      } catch (error) {
        if (isLocationServicesDisabledError(error)) {
          return emptySnapshot('unavailable', false);
        }
        const mapped = mapNativePositionError(error);
        if (mapped.kind === 'permission') return emptySnapshot('denied', true);
        throw mapped;
      }
    },
  };
};

export const createParQueenGeolocation = (
  path: GeolocationPath = resolveGeolocationPath(),
  nativePlugin: NativeGeolocationPlugin = CapacitorGeolocation,
  browserDeps?: BrowserGeolocationDeps,
): LocationBackend => (
  path === 'native' ? createNativeGeolocation(nativePlugin) : createBrowserGeolocation(browserDeps)
);

let backend: LocationBackend = createParQueenGeolocation();

/** Test-only: replace the process-wide backend. */
export const __setLocationBackendForTests = (next?: LocationBackend): void => {
  backend = next ?? createParQueenGeolocation();
};

export const getLocationBackend = (): LocationBackend => backend;

export const isGeolocationAvailable = (): boolean => backend.isAvailable();

export const getCurrentPosition = (options?: AppPositionOptions): Promise<AppPosition> => (
  backend.getCurrentPosition(options)
);

export const watchPosition = (
  onSuccess: (position: AppPosition) => void,
  onError?: (error: LocationPositionError) => void,
  options?: AppPositionOptions,
): LocationWatchHandle => backend.watchPosition(onSuccess, onError, options);

export const checkLocationPermission = (): Promise<LocationPermissionSnapshot> => backend.checkPermission();

export const requestLocationPermission = (): Promise<LocationPermissionSnapshot> => backend.requestPermission();
