import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const root = process.cwd();
const viteBin = resolve(root, 'node_modules/vite/bin/vite.js');
const tempDirs: string[] = [];

const makeTempDir = (prefix: string): string => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
};

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

const childEnvWithoutMapbox = (extra: Record<string, string>): NodeJS.ProcessEnv => {
  const env = { ...process.env, ...extra };
  delete env.VITE_MAPBOX_TOKEN;
  return env;
};

const isolatedContractEnv = (envDir: string, extraEnv: Record<string, string> = {}) =>
  childEnvWithoutMapbox({
    PARQUEEN_CONFIG_CONTRACT_TEST: '1',
    PARQUEEN_VITE_ENV_DIR: envDir,
    ...extraEnv,
  });

const runViteBuild = (
  envDir: string,
  outDir: string,
  extraArgs: string[] = [],
  extraEnv: Record<string, string> = {},
) =>
  spawnSync(process.execPath, [viteBin, 'build', '--outDir', outDir, '--emptyOutDir', ...extraArgs], {
    cwd: root,
    encoding: 'utf8',
    env: isolatedContractEnv(envDir, extraEnv),
    timeout: 120_000,
  });

const combinedOutput = (result: ReturnType<typeof spawnSync>): string =>
  `${result.stdout ?? ''}\n${result.stderr ?? ''}`;

describe('production Vite build configuration contract', () => {
  it('fails closed when VITE_MAPBOX_TOKEN is absent from isolated env files and the process environment', { timeout: 180_000 }, () => {
    const envDir = makeTempDir('parqueen-vite-env-missing-');
    const outDir = makeTempDir('parqueen-vite-out-missing-');
    writeFileSync(join(envDir, '.env.production'), 'VITE_SENTRY_DSN=\n', 'utf8');

    const result = runViteBuild(envDir, outDir);
    const output = combinedOutput(result);

    expect(result.status, output).not.toBe(0);
    expect(output).toContain('[configuration] Production build requires VITE_MAPBOX_TOKEN.');
    expect(output).not.toContain('pk.');
    expect(existsSync(join(outDir, 'index.html'))).toBe(false);
  });

  it('fails closed for vite build --mode staging when VITE_MAPBOX_TOKEN is absent', { timeout: 180_000 }, () => {
    const envDir = makeTempDir('parqueen-vite-env-staging-');
    const outDir = makeTempDir('parqueen-vite-out-staging-');
    writeFileSync(join(envDir, '.env.staging'), 'VITE_SENTRY_DSN=\n', 'utf8');

    const result = runViteBuild(envDir, outDir, ['--mode', 'staging']);
    const output = combinedOutput(result);

    expect(result.status, output).not.toBe(0);
    expect(output).toContain('VITE_MAPBOX_TOKEN');
    expect(output).not.toContain('pk.');
    expect(existsSync(join(outDir, 'index.html'))).toBe(false);
  });

  it('does not treat a whitespace-only Mapbox token in an isolated env dir as configured', { timeout: 180_000 }, () => {
    const envDir = makeTempDir('parqueen-vite-env-blank-');
    const outDir = makeTempDir('parqueen-vite-out-blank-');
    writeFileSync(join(envDir, '.env.production'), 'VITE_MAPBOX_TOKEN=   \n', 'utf8');

    const result = runViteBuild(envDir, outDir);
    const output = combinedOutput(result);

    expect(result.status, output).not.toBe(0);
    expect(output).toContain('VITE_MAPBOX_TOKEN');
    expect(existsSync(join(outDir, 'index.html'))).toBe(false);
  });

  it('does not honor PARQUEEN_VITE_ENV_DIR without the contract-test marker', { timeout: 180_000 }, () => {
    const source = readFileSync(resolve(root, 'productionBuildConfig.ts'), 'utf8');
    expect(source).toContain("CONFIG_CONTRACT_TEST_MARKER = 'PARQUEEN_CONFIG_CONTRACT_TEST'");
    expect(source).toContain("?.trim() === '1'");
    expect(source).not.toMatch(/define:\s*\{[^}]*PARQUEEN_/s);
  });

  it('wires the build-command guard and dual-marker env-dir isolation into vite.config.ts', () => {
    const source = readFileSync(resolve(root, 'vite.config.ts'), 'utf8');
    expect(source).toContain("from './productionBuildConfig'");
    expect(source).toContain('defineConfig(({ command, mode })');
    expect(source).toContain('resolveViteEnvDir');
    expect(source).toContain('applyProductionBuildConfigGuard(command, env)');
    expect(source).toContain('loadEnv(mode, envDir,');
    expect(source).not.toContain('applyProductionBuildConfigGuard(mode, env)');
  });
});
