/**
 * Default-off client exposure for Street Intelligence RC03 presentation:
 * staged Street Parking copy, diagonal curb drawing, and any future
 * production GPS-burst changes that are not already isolated to the
 * streetintelqa package build.
 *
 * Enable only with the explicit approved build flag
 * VITE_PARQUEEN_STREET_INTEL_CLIENT_FEATURES=on. Unset, empty, or any
 * other value keeps main-equivalent client behavior.
 */
export const STREET_INTEL_CLIENT_FEATURES_FLAG = 'VITE_PARQUEEN_STREET_INTEL_CLIENT_FEATURES';

export function streetIntelClientFeaturesEnabled(
  env: { VITE_PARQUEEN_STREET_INTEL_CLIENT_FEATURES?: string } = import.meta.env as {
    VITE_PARQUEEN_STREET_INTEL_CLIENT_FEATURES?: string;
  },
): boolean {
  return env?.VITE_PARQUEEN_STREET_INTEL_CLIENT_FEATURES === 'on';
}
