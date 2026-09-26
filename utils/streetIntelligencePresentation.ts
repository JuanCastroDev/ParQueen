export type StreetIntelligencePresentationState = 'supported' | 'caution' | 'unknown';
export type StreetIntelligenceSource = 'admin' | 'sweepnyc' | 'nyc_open_data' | 'park_nyc';

/**
 * Why a result is not fully confident. The UI names the actual doubt instead of
 * printing a generic "review recommended" over every result.
 */
export type StreetIntelligenceCautionReason =
  | 'side_unresolved'
  | 'block_not_decisive'
  | 'conflicting_schedules'
  | 'incomplete_parse'
  | 'flagged_for_review'
  | 'low_confidence';

export interface StreetIntelligencePresentation {
  state: StreetIntelligencePresentationState;
  source: StreetIntelligenceSource | null;
  lastSourceSync: string | null;
  /** Empty when state is 'supported'. Most significant first. */
  reasons: StreetIntelligenceCautionReason[];
}

const SOURCES: StreetIntelligenceSource[] = ['admin', 'sweepnyc', 'nyc_open_data', 'park_nyc'];

/**
 * All three are authoritative publishers: ParQueen's own reviewed data, SweepNYC,
 * and NYC's own Open Data. Being the fallback route makes a result later, not
 * less true, so provider identity alone no longer downgrades a result -- only the
 * evidence attached to it does.
 */
function isSource(value: unknown): value is StreetIntelligenceSource {
  return typeof value === 'string' && SOURCES.includes(value as StreetIntelligenceSource);
}

/**
 * A floor, not an allowlist of exact values. The previous check required
 * (admin && === 1) || (sweepnyc && === 0.95), which no nyc_open_data segment
 * could ever satisfy no matter how decisive its evidence.
 */
const CONFIDENCE_FLOOR = 0.9;

function latestSourceSync(rules: Record<string, any>[]): string | null {
  const values = rules
    .map(rule => rule.lastSourceSync)
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    .sort();
  return values.length > 0 ? values[values.length - 1] : null;
}

/**
 * Canonical fingerprint for one schedule window. Day order is sorted so
 * ["Thu","Mon"] matches ["Mon","Thu"]. ruleType is material when present:
 * CleaningSchedule uses it for metered_no_parking_window vs classic ASP
 * (absent). Missing / blank / whitespace-only all mean classic ASP.
 */
function canonicalizeSchedule(s: Record<string, any>): string | null {
  const side = String(s?.side ?? '').trim();
  if (!side) return null;
  const days = (Array.isArray(s.days) ? s.days : [])
    .map((d: unknown) => String(d).trim())
    .filter(Boolean)
    .sort((a: string, b: string) => a.localeCompare(b));
  const startTime = String(s?.startTime ?? '').trim();
  const endTime = String(s?.endTime ?? '').trim();
  const rawType = typeof s?.ruleType === 'string' ? s.ruleType.trim() : '';
  // Empty means classic ASP; non-empty values (e.g. metered_no_parking_window) differ.
  const ruleType = rawType;
  return `${side}|${days.join(',')}|${startTime}|${endTime}|${ruleType}`;
}

/**
 * Mixed sources are only a problem when their complete schedule sets for a
 * side disagree. One source may publish multiple windows on one side; that is
 * not a conflict. Compare source+side complete sets, not global window keys.
 */
function hasConflictingSchedules(rules: Record<string, any>[]): boolean {
  // side -> source -> sorted unique canonical schedule keys for that source+side
  const bySide = new Map<string, Map<string, Set<string>>>();

  for (const rule of rules) {
    if (rule?.type === 'meter' || rule?.type === 'curbRestrictionSet' || rule?.type === 'noParking'
      || rule?.type === 'noStanding' || rule?.type === 'noStopping' || rule?.type === 'timeLimited') continue;
    const source = typeof rule?.source === 'string' ? rule.source : '';
    if (!source) continue;
    for (const schedule of Array.isArray(rule.schedules) ? rule.schedules : []) {
      const key = canonicalizeSchedule(schedule);
      if (!key) continue;
      const side = String(schedule?.side ?? '').trim();
      let bySource = bySide.get(side);
      if (!bySource) {
        bySource = new Map();
        bySide.set(side, bySource);
      }
      let set = bySource.get(source);
      if (!set) {
        set = new Set();
        bySource.set(source, set);
      }
      set.add(key);
    }
  }

  for (const bySource of bySide.values()) {
    if (bySource.size < 2) continue; // fewer than two sources for this side: no cross-source conflict
    const fingerprints: string[] = [];
    for (const set of bySource.values()) {
      fingerprints.push([...set].sort((a, b) => a.localeCompare(b)).join('||'));
    }
    const distinct = new Set(fingerprints);
    if (distinct.size > 1) return true;
  }
  return false;
}

export function classifyStreetIntelligence(
  segment: Record<string, any> | null,
  rules: Record<string, any>[],
  _now: number = Date.now(),
): StreetIntelligencePresentation {
  const unknown: StreetIntelligencePresentation = {
    state: 'unknown',
    source: null,
    lastSourceSync: null,
    reasons: [],
  };

  if (!segment || !Array.isArray(rules) || rules.length === 0) return unknown;
  if (segment.status !== 'active' && segment.status !== 'needs_review') return unknown;
  if (segment.protocolVersion === 2) {
    const version = segment.activeRuleSetVersion;
    if (segment.status !== 'active' || typeof version !== 'string' || !version
      || rules.some(rule => rule.protocolVersion !== 2 || rule.ruleSetVersion !== version
        || !isSource(rule.source))) return unknown;
    const usableSchedules = rules.flatMap(rule => Array.isArray(rule.schedules) ? rule.schedules : []);
    if (usableSchedules.length === 0) return unknown;
    const normalizedSources = rules.map(rule => rule.source).filter(isSource);
    const distinctSources = [...new Set(normalizedSources)];
    return {
      state: 'supported',
      source: distinctSources.length === 1 ? distinctSources[0] : null,
      lastSourceSync: latestSourceSync(rules),
      reasons: [],
    };
  }
  if (!isSource(segment.source) || !isSource(segment.provenance?.provider)) return unknown;
  if (segment.source !== segment.provenance.provider) return unknown;
  if (typeof segment.confidenceScore !== 'number' || !Number.isFinite(segment.confidenceScore)) return unknown;
  if (rules.some(rule => !isSource(rule.source))) return unknown;

  const usableSchedules = rules.flatMap(rule => Array.isArray(rule.schedules) ? rule.schedules : []);
  if (usableSchedules.length === 0) return unknown;

  const ruleSources = [...new Set(rules.map(rule => rule.source as StreetIntelligenceSource))];
  const source = ruleSources.length === 1 ? ruleSources[0] : null;
  const lastSourceSync = latestSourceSync(rules);

  // Evidence the producer recorded about how the block face was resolved. Absent
  // on segments written before it was persisted, which stay conservative.
  const evidence = segment.blockFaceEvidence ?? null;

  const reasons: StreetIntelligenceCautionReason[] = [];

  if (segment.status === 'needs_review'
    || segment.needsReview === true
    || rules.some(rule => rule.needsReview === true)
    || segment.confidence?.level === 'flagged'
    || segment.confidence?.level === 'unverified') {
    reasons.push('flagged_for_review');
  }
  if (evidence && evidence.blockDecisive === false) reasons.push('block_not_decisive');
  if (evidence && evidence.sideResolved === false) reasons.push('side_unresolved');
  if (evidence && evidence.parseComplete === false) reasons.push('incomplete_parse');
  if (hasConflictingSchedules(rules)) reasons.push('conflicting_schedules');
  if (segment.confidenceScore < CONFIDENCE_FLOOR) reasons.push('low_confidence');

  return {
    state: reasons.length > 0 ? 'caution' : 'supported',
    source,
    lastSourceSync,
    reasons,
  };
}
