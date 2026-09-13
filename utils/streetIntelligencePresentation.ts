export type StreetIntelligencePresentationState = 'supported' | 'caution' | 'unknown';
export type StreetIntelligenceSource = 'admin' | 'sweepnyc' | 'nyc_open_data';

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

const SOURCES: StreetIntelligenceSource[] = ['admin', 'sweepnyc', 'nyc_open_data'];

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

const scheduleKey = (s: Record<string, any>) =>
  `${s.side ?? ''}|${(Array.isArray(s.days) ? s.days : []).join(',')}|${s.startTime ?? ''}|${s.endTime ?? ''}|${s.ruleType ?? ''}`;

/**
 * Mixed sources are only a problem when they disagree. Two providers publishing
 * the same window for the same side is corroboration, not conflict.
 */
function hasConflictingSchedules(rules: Record<string, any>[]): boolean {
  const bySide = new Map<string, Set<string>>();
  for (const rule of rules) {
    for (const schedule of Array.isArray(rule.schedules) ? rule.schedules : []) {
      const side = String(schedule?.side ?? '');
      if (!side) continue;
      const set = bySide.get(side) ?? new Set<string>();
      set.add(scheduleKey(schedule));
      bySide.set(side, set);
    }
  }
  for (const keys of bySide.values()) if (keys.size > 1) return true;
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
