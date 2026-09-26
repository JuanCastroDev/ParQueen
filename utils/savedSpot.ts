/**
 * The "My Car" saved parking spot.
 *
 * This is the single source of truth for the saved spot, shared by the map
 * (StreetParkingView) and the AI Parking Assistant. The storage key and the
 * serialized shape are unchanged from when this lived inside StreetParkingView
 * — nothing here migrates or rewrites an existing session beyond the
 * field back-fills that were already happening on read.
 */

import { parseCanonicalCurbResponse } from './canonicalCurbClient';

export const SAVED_SPOT_KEY = 'pq_saved_spot';

/** Sessions older than this are dropped on read, as they always have been. */
export const SAVED_SPOT_TTL_MS = 24 * 60 * 60 * 1000;

export type SideConfidence = 'high' | 'low' | 'unknown';
export type StreetIntelStatus = 'found' | 'unavailable' | 'failed';
export type CurbResolutionStatus = 'resolving' | 'high_confidence' | 'ambiguous' | 'unsupported';

export interface SavedSpot {
  lat: number;
  lng: number;
  address: string;
  savedAt: number;
  sessionId: string;            // stable ID for deterministic ping creation
  linkedPingId: string | null;  // set after first successful ping — prevents duplicates
  // Street Intelligence — null if no segment matched
  segmentId: string | null;
  parkingSide: string | null;
  restrictionVersionId: string | null;
  segmentStreetName: string | null;
  // Street Intelligence lookup outcome
  streetIntelStatus: StreetIntelStatus | null;
  streetIntelReason: string | null;
  streetIntelCheckedAt: string | null;
  // Canonical curb V2. Null denotes a readable pre-V2 session.
  curbProtocolVersion: 2 | null;
  curbResolutionStatus: CurbResolutionStatus | null;
  curbSelector: import('./canonicalCurbClient').CanonicalCurbSelector | null;
  curbRefreshAttempted: boolean;
  // Side confidence — drives whether to show Safe Until or ask the user to confirm
  gpsAccuracyMeters: number | null;
  sideConfidence: SideConfidence;
  confirmedParkingSide: string | null;
}

interface MinStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function storage(): MinStorage | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    return localStorage;
  } catch {
    // Private mode / blocked site data.
    return null;
  }
}

/**
 * The side actually safe to evaluate against.
 *
 * A GPS-derived side is only trusted at high confidence; otherwise the user has
 * to confirm it. Returning null means "we do not know which side of the street
 * this car is on", which callers must treat as uncertainty rather than guessing.
 */
export function effectiveParkingSide(spot: Pick<SavedSpot, 'parkingSide' | 'sideConfidence' | 'confirmedParkingSide'>): string | null {
  return spot.confirmedParkingSide || (spot.sideConfidence === 'high' ? spot.parkingSide : null);
}

/**
 * Reads and repairs the saved spot, or returns null.
 *
 * localStorage is untrusted input: anything the app cannot rely on (a
 * non-finite coordinate, a non-object payload) is discarded rather than handed
 * to code that will do arithmetic with it.
 */
export function readSavedSpot(now: number = Date.now()): SavedSpot | null {
  const store = storage();
  if (!store) return null;
  try {
    const raw = store.getItem(SAVED_SPOT_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw);
    if (!s || typeof s !== 'object' || Array.isArray(s)) return null;

    // Coordinates are the one thing every consumer does maths on.
    if (!Number.isFinite(s.lat) || !Number.isFinite(s.lng)) return null;
    if (!Number.isFinite(s.savedAt)) return null;

    // Auto-expire after 24 hours if no timer was set.
    if (now - s.savedAt > SAVED_SPOT_TTL_MS) {
      store.removeItem(SAVED_SPOT_KEY);
      return null;
    }

    // Back-fill sessions that predate later fields. Unchanged from the
    // original read path, including the write-back.
    let changed = false;
    if (!s.sessionId) { s.sessionId = Date.now().toString(36); changed = true; }
    if (s.linkedPingId === undefined) { s.linkedPingId = null; changed = true; }
    if (s.gpsAccuracyMeters === undefined) { s.gpsAccuracyMeters = null; changed = true; }
    if (!s.sideConfidence) { s.sideConfidence = s.parkingSide ? 'low' : 'unknown'; changed = true; }
    if (s.confirmedParkingSide === undefined) { s.confirmedParkingSide = null; changed = true; }
    if (typeof s.address !== 'string') { s.address = ''; changed = true; }
    if (s.curbProtocolVersion !== 2 && s.curbProtocolVersion !== null) {
      s.curbProtocolVersion = null; changed = true;
    }
    if (s.curbResolutionStatus !== null
      && !['resolving', 'high_confidence', 'ambiguous', 'unsupported'].includes(s.curbResolutionStatus)) {
      s.curbResolutionStatus = null; changed = true;
    }
    if (s.curbSelector === undefined) { s.curbSelector = null; changed = true; }
    if (s.curbResolutionStatus === 'ambiguous') {
      try {
        const parsed = parseCanonicalCurbResponse({
          protocolVersion: 2,
          status: 'ambiguous',
          selector: s.curbSelector,
        });
        s.curbSelector = parsed.status === 'ambiguous' ? parsed.selector : null;
      } catch {
        s.curbResolutionStatus = 'unsupported';
        s.curbSelector = null;
        s.streetIntelStatus = 'unavailable';
        s.streetIntelReason = 'candidate_incomplete';
        changed = true;
      }
    }
    if (typeof s.curbRefreshAttempted !== 'boolean') { s.curbRefreshAttempted = false; changed = true; }
    if (changed) store.setItem(SAVED_SPOT_KEY, JSON.stringify(s));

    return s as SavedSpot;
  } catch {
    return null;
  }
}

export function writeSavedSpot(spot: SavedSpot): void {
  const store = storage();
  if (!store) return;
  try {
    store.setItem(SAVED_SPOT_KEY, JSON.stringify(spot));
  } catch {
    // Storage full or blocked — the in-memory session still works.
  }
}

export function clearSavedSpot(): void {
  const store = storage();
  if (!store) return;
  try {
    store.removeItem(SAVED_SPOT_KEY);
  } catch {
    // nothing to do
  }
}
