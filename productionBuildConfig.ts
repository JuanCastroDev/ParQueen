export const PRODUCTION_REQUIRED_CLIENT_VARS = ['VITE_MAPBOX_TOKEN'] as const;

export const VITE_ENV_DIR_OVERRIDE = 'PARQUEEN_VITE_ENV_DIR';
export const CONFIG_CONTRACT_TEST_MARKER = 'PARQUEEN_CONFIG_CONTRACT_TEST';

export type ProductionBuildEnv = Record<string, string | undefined>;

export type ProductionBuildConfigResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly missing: readonly string[] };

const isBlank = (value: string | undefined): boolean => !value?.trim();

export function missingProductionBuildConfig(env: ProductionBuildEnv): string[] {
  return PRODUCTION_REQUIRED_CLIENT_VARS.filter((name) => isBlank(env[name]));
}

export function validateProductionBuildConfig(env: ProductionBuildEnv): ProductionBuildConfigResult {
  const missing = missingProductionBuildConfig(env);
  return missing.length === 0 ? { ok: true } : { ok: false, missing };
}

export function assertProductionBuildConfig(env: ProductionBuildEnv): void {
  const missing = missingProductionBuildConfig(env);
  if (missing.length === 0) return;
  throw new Error(`[configuration] Production build requires ${missing.join(', ')}.`);
}

/**
 * Fail-closed trigger is Vite's `command`, not `mode`.
 * `vite build --mode staging` is still a distributable build.
 * `vite` / `command === 'serve'` is the dev server and is not blocked here.
 */
export function applyProductionBuildConfigGuard(command: string, env: ProductionBuildEnv): void {
  if (command !== 'build') return;
  assertProductionBuildConfig(env);
}

export function resolveViteEnvDir(
  env: ProductionBuildEnv = process.env,
  cwd: string = process.cwd(),
): string {
  const contractTestActive = env[CONFIG_CONTRACT_TEST_MARKER]?.trim() === '1';
  const override = env[VITE_ENV_DIR_OVERRIDE]?.trim();
  if (contractTestActive && override) return override;
  return cwd;
}
