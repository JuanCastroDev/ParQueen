import { streetIntelQaBuild } from './demoFirebase';

/**
 * Recorded hydrant distance for the isolated Street Intelligence QA package.
 *
 * The QA app does not call checkHydrantDistance. A session value is accepted
 * only when this build is the QA package, so a planted value in any other
 * build cannot replace the server lookup.
 */
export const STREET_INTEL_QA_HYDRANT_KEY = 'pq_qa_hydrant_lookup';

const STATUSES = ['found', 'none_nearby', 'unavailable', 'out_of_area'] as const;

function isQaHydrantStatus(value: string): value is QaHydrantLookup['status'] {
  return (STATUSES as readonly string[]).includes(value);
}

export interface QaHydrantLookup {
  status: (typeof STATUSES)[number];
  meters: number | null;
}

interface FixtureStorage {
  getItem(key: string): string | null;
}

export function readQaHydrantFixture(options?: {
  qaBuild?: boolean;
  storage?: FixtureStorage | null;
}): QaHydrantLookup | null {
  const qaBuild = options?.qaBuild ?? streetIntelQaBuild();
  if (!qaBuild) return null;
  const storage = options && 'storage' in options
    ? options.storage
    : (typeof sessionStorage === 'undefined' ? null : sessionStorage);
  if (!storage) return null;
  let parsed: unknown;
  try {
    const raw = storage.getItem(STREET_INTEL_QA_HYDRANT_KEY);
    if (!raw) return null;
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const status = (parsed as { status?: unknown }).status;
  const meters = (parsed as { meters?: unknown }).meters;
  if (typeof status !== 'string' || !isQaHydrantStatus(status)) return null;
  if (status === 'found') {
    if (typeof meters !== 'number' || !Number.isFinite(meters) || meters < 0) return null;
    return { status, meters };
  }
  if (meters != null) return null;
  return { status, meters: null };
}
