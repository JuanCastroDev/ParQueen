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
  delete env.VITE_POSTHOG_ENABLED;
  delete env.VITE_POSTHOG_PROJECT_TOKEN;
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


describe('PostHog release Vite contract', () => {
  it('rejects token contamination even when enabled flag is false', { timeout: 180_000 }, () => {
    const envDir = makeTempDir('pq-posthog-token-env-');
    const outDir = makeTempDir('pq-posthog-token-out-');
    writeFileSync(join(envDir, '.env.production'),
      'VITE_MAPBOX_TOKEN=pk.configured\nVITE_POSTHOG_ENABLED=false\nVITE_POSTHOG_PROJECT_TOKEN=phc_fake_token_here\n');
    const result = runViteBuild(envDir, outDir);
    const output = combinedOutput(result);
    expect(result.status, output).not.toBe(0);
    expect(output).toContain('PostHog release must remain OFF');
    expect(output).not.toContain('phc_fake_token_here');
    expect(existsSync(join(outDir, 'index.html'))).toBe(false);
  });
  it('rejects an enabled flag in staging mode', { timeout: 180_000 }, () => {
    const envDir = makeTempDir('pq-posthog-enabled-env-');
    const outDir = makeTempDir('pq-posthog-enabled-out-');
    writeFileSync(join(envDir, '.env.staging'),
      'VITE_MAPBOX_TOKEN=pk.configured\nVITE_POSTHOG_ENABLED=true\n');
    const result = runViteBuild(envDir, outDir, ['--mode', 'staging']);
    expect(result.status, combinedOutput(result)).not.toBe(0);
    expect(combinedOutput(result)).toContain('PostHog release must remain OFF');
    expect(existsSync(join(outDir, 'index.html'))).toBe(false);
  });
  it('adds a verifiable OFF marker to a clean built artifact', { timeout: 180_000 }, () => {
    const envDir = makeTempDir('pq-posthog-off-env-');
    const outDir = makeTempDir('pq-posthog-off-out-');
    writeFileSync(join(envDir, '.env.production'),
      'VITE_MAPBOX_TOKEN=pk.configured\nVITE_POSTHOG_ENABLED=false\n');
    const result = runViteBuild(envDir, outDir);
    expect(result.status, combinedOutput(result)).toBe(0);
    expect(readFileSync(join(outDir, 'index.html'), 'utf8'))
      .toContain('<meta name="parqueen-posthog-release" content="off" />');
  });
});
