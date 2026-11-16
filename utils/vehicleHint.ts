// Onboarding 2.0 (Blueprint D22, closure contract C3): one optional, non-blocking suggestion to add car details,
// offered after the user's first successfully published Ping. Vehicle details are never required.
//
// All of these must hold:
//  1. a NEW Ping publication succeeded (edits, failures and rate-limit denials never qualify);
//  2. the user has no vehicle type, brand or colour;
//  3. an authoritative server read of users/{uid} taken before the publish shows impactStats.pingsShared 0 or absent
//     (no server answer = skip, never defer);
//  4. the device guard is not set;
//  5. the in-memory session flag is not set.
// Showing it once counts as done.

export const VEHICLE_HINT_KEY = 'parqueen_vehicle_hint_done_v1';

let sessionShown = false;

type VehicleFields = { vehicleType?: unknown; vehicleBrand?: unknown; vehicleColor?: unknown } | null | undefined;

export function hasVehicleDetails(user: VehicleFields): boolean {
  return !!(user?.vehicleType || user?.vehicleBrand || user?.vehicleColor);
}

function deviceGuardSet(): boolean {
  try { return localStorage.getItem(VEHICLE_HINT_KEY) === '1'; } catch { return true; }
}

/**
 * @param pingsSharedBefore value of impactStats.pingsShared from a server (non-cache) read taken before the publish;
 *   0 when the field is absent; null when no authoritative answer was available.
 */
export function shouldOfferVehicleHint(args: { newPublication: boolean; user: VehicleFields; pingsSharedBefore: number | null }): boolean {
  if (!args.newPublication) return false;
  if (hasVehicleDetails(args.user)) return false;
  if (args.pingsSharedBefore === null || args.pingsSharedBefore !== 0) return false;
  if (sessionShown || deviceGuardSet()) return false;
  return true;
}

export function markVehicleHintShown(): void {
  sessionShown = true;
  try { localStorage.setItem(VEHICLE_HINT_KEY, '1'); } catch { /* the session flag still prevents a repeat */ }
}

/** Normalises the server value: absent counts as 0; anything that is not a non-negative number is not authoritative. */
export function readPingsShared(data: Record<string, any> | undefined | null): number | null {
  if (!data) return null;
  const value = data.impactStats?.pingsShared;
  if (value === undefined || value === null) return 0;
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

/** Test-only reset of the in-memory session flag. */
export function __resetVehicleHintSessionForTests(): void {
  sessionShown = false;
}
