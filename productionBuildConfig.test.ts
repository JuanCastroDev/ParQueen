import { describe, expect, it } from 'vitest';
import {
  applyProductionBuildConfigGuard,
  assertProductionBuildConfig,
  resolveViteEnvDir,
  validateProductionBuildConfig,
} from './productionBuildConfig';

const MAPBOX_SENTINEL = 'pk.test-token-must-never-appear-in-errors';

describe('validateProductionBuildConfig', () => {
  it.each([
    ['missing', {}],
    ['empty', { VITE_MAPBOX_TOKEN: '' }],
    ['whitespace', { VITE_MAPBOX_TOKEN: ' \t  ' }],
  ])('rejects a %s Mapbox token', (_label, env) => {
    expect(validateProductionBuildConfig(env)).toEqual({
      ok: false,
      missing: ['VITE_MAPBOX_TOKEN'],
    });
  });

  it('accepts a nonblank Mapbox token', () => {
    expect(validateProductionBuildConfig({ VITE_MAPBOX_TOKEN: 'pk.configured' })).toEqual({ ok: true });
  });

  it('does not require optional Sentry, App Check debug, or web App Check site-key values', () => {
    const result = validateProductionBuildConfig({
      VITE_MAPBOX_TOKEN: 'pk.configured',
    });
    expect(result).toEqual({ ok: true });
  });
});

describe('assertProductionBuildConfig', () => {
  it('names VITE_MAPBOX_TOKEN and never includes supplied environment values', () => {
    const env = {
      VITE_MAPBOX_TOKEN: '   ',
      VITE_SENTRY_DSN: 'https://sentry.example/dsn-must-not-leak',
      SENTRY_AUTH_TOKEN: 'sentry-auth-must-not-leak',
      VITE_APPCHECK_DEBUG_TOKEN: 'debug-token-must-not-leak',
      VITE_FIREBASE_APPCHECK_SITE_KEY: 'site-key-must-not-leak',
      UNRELATED_SECRET: MAPBOX_SENTINEL,
    };

    expect(() => assertProductionBuildConfig(env)).toThrow(
      '[configuration] Production build requires VITE_MAPBOX_TOKEN.',
    );

    try {
      assertProductionBuildConfig(env);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).toContain('VITE_MAPBOX_TOKEN');
      expect(message).not.toContain(MAPBOX_SENTINEL);
      expect(message).not.toContain('https://sentry.example/dsn-must-not-leak');
      expect(message).not.toContain('sentry-auth-must-not-leak');
      expect(message).not.toContain('debug-token-must-not-leak');
      expect(message).not.toContain('site-key-must-not-leak');
    }
  });
});

describe('applyProductionBuildConfigGuard', () => {
  it('blocks command=build when VITE_MAPBOX_TOKEN is missing', () => {
    expect(() => applyProductionBuildConfigGuard('build', {})).toThrow(
      '[configuration] Production build requires VITE_MAPBOX_TOKEN.',
    );
  });

  it('blocks command=build for a custom mode when VITE_MAPBOX_TOKEN is missing', () => {
    expect(() => applyProductionBuildConfigGuard('build', {
      VITE_MAPBOX_TOKEN: '',
    })).toThrow('[configuration] Production build requires VITE_MAPBOX_TOKEN.');
  });

  it('allows command=build when the Mapbox token is nonblank', () => {
    expect(() => applyProductionBuildConfigGuard('build', {
      VITE_MAPBOX_TOKEN: 'pk.configured',
    })).not.toThrow();
  });

  it('does not block command=serve when VITE_MAPBOX_TOKEN is missing', () => {
    expect(() => applyProductionBuildConfigGuard('serve', {})).not.toThrow();
    expect(() => applyProductionBuildConfigGuard('serve', { VITE_MAPBOX_TOKEN: '' })).not.toThrow();
  });

  it('does not treat Vite mode names as the fail-closed trigger', () => {
    expect(() => applyProductionBuildConfigGuard('production', {})).not.toThrow();
    expect(() => applyProductionBuildConfigGuard('staging', {})).not.toThrow();
    expect(() => applyProductionBuildConfigGuard('development', {})).not.toThrow();
  });
});

describe('resolveViteEnvDir', () => {
  const override = 'C:\\tmp\\vite-env-isolation';
  const cwd = 'C:\\repo';

  it('ignores PARQUEEN_VITE_ENV_DIR unless the config-contract-test marker is set', () => {
    expect(resolveViteEnvDir(
      { PARQUEEN_VITE_ENV_DIR: override },
      cwd,
    )).toBe(cwd);
  });

  it('ignores the contract-test marker without an env-dir override', () => {
    expect(resolveViteEnvDir(
      { PARQUEEN_CONFIG_CONTRACT_TEST: '1' },
      cwd,
    )).toBe(cwd);
  });

  it('uses PARQUEEN_VITE_ENV_DIR only when PARQUEEN_CONFIG_CONTRACT_TEST=1', () => {
    expect(resolveViteEnvDir(
      {
        PARQUEEN_VITE_ENV_DIR: override,
        PARQUEEN_CONFIG_CONTRACT_TEST: '1',
      },
      cwd,
    )).toBe(override);
  });

  it('does not honor a non-1 contract-test marker', () => {
    expect(resolveViteEnvDir(
      {
        PARQUEEN_VITE_ENV_DIR: override,
        PARQUEEN_CONFIG_CONTRACT_TEST: 'true',
      },
      cwd,
    )).toBe(cwd);
  });

  it('falls back to the process cwd when no isolation override is set', () => {
    expect(resolveViteEnvDir({}, cwd)).toBe(cwd);
  });
});
