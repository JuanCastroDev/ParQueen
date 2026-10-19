import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { requiredBrowserCredential, resolveMapboxToken } from './browserCredentials';

describe('requiredBrowserCredential', () => {
  it('returns a configured value', () => {
    expect(requiredBrowserCredential('VITE_EXAMPLE', 'configured')).toBe('configured');
  });

  it.each([undefined, '', '   '])('rejects a missing Mapbox token with the intended error', value => {
    expect(() => requiredBrowserCredential('VITE_MAPBOX_TOKEN', value)).toThrow(
      'VITE_MAPBOX_TOKEN is required',
    );
  });
});


describe('resolveMapboxToken', () => {
  it('uses the web token for browsers', () => {
    expect(resolveMapboxToken({
      isNative: false,
      platform: 'web',
      webToken: 'web-token',
      iosToken: 'ios-token',
      androidToken: 'android-token',
    })).toBe('web-token');
  });

  it('uses the web token for installed PWAs', () => {
    expect(resolveMapboxToken({
      isNative: false,
      platform: 'web',
      webToken: 'web-token',
      iosToken: 'ios-token',
      androidToken: 'android-token',
    })).toBe('web-token');
  });

  it('uses the dedicated token for Capacitor iOS', () => {
    expect(resolveMapboxToken({
      isNative: true,
      platform: 'ios',
      webToken: 'web-token',
      iosToken: '  ios-token  ',
      androidToken: 'android-token',
    })).toBe('ios-token');
  });

  it('uses the dedicated token for Capacitor Android', () => {
    expect(resolveMapboxToken({
      isNative: true,
      platform: 'android',
      webToken: 'web-token',
      iosToken: 'ios-token',
      androidToken: '  android-token  ',
    })).toBe('android-token');
  });

  it.each([undefined, '', '   '])(
    'fails closed instead of falling back to the web token when the Android token is %j',
    androidToken => {
      expect(() => resolveMapboxToken({
        isNative: true,
        platform: 'android',
        webToken: 'web-token',
        iosToken: 'ios-token',
        androidToken,
      })).toThrow('VITE_MAPBOX_ANDROID_TOKEN is required');
    },
  );

  it('fails closed when the dedicated iOS token is missing', () => {
    expect(() => resolveMapboxToken({
      isNative: true,
      platform: 'ios',
      webToken: 'web-token',
      iosToken: '',
      androidToken: 'android-token',
    })).toThrow('VITE_MAPBOX_IOS_TOKEN is required');
  });
});

describe('browser mapping architecture', () => {
  const root = process.cwd();
  const read = (path: string) => readFileSync(resolve(root, path), 'utf8');

  it('requires no Google Maps browser credential', () => {
    expect(read('.env.example')).not.toContain('VITE_GOOGLE_MAPS_API_KEY');
    expect(read('utils/browserCredentials.ts')).not.toContain('VITE_GOOGLE_MAPS_API_KEY');
  });

  it('has no Google Places request path', () => {
    expect(existsSync(resolve(root, 'hooks/useLocalParkingData.ts'))).toBe(false);
    expect(read('views/street-parking/useSpotData.ts')).not.toContain('places.googleapis.com');
  });

  it('keeps active Mapbox rendering, search, reverse geocoding, and directions wired', () => {
    const mapView = read('views/StreetParkingView.tsx');
    const search = read('views/street-parking/useSearch.ts');
    const mapUtils = read('views/street-parking/utils.ts');

    expect(mapView).toContain('mapbox://styles/mapbox/');
    expect(mapView).toContain('getMapboxToken()');
    expect(search).toContain('api.mapbox.com/geocoding');
    expect(mapUtils).toContain('api.mapbox.com/directions');
  });
});
