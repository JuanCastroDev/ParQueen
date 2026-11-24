export const REGULATION_CATEGORIES = ['cleaning', 'restrictions', 'timeLimits', 'meters'] as const;

export type RegulationCategory = typeof REGULATION_CATEGORIES[number];
export type RegulationCategoryState = 'verified' | 'verified_empty' | 'unknown' | 'incomplete' | 'conflict';
export type RegulationCoverage = Readonly<Record<RegulationCategory, RegulationCategoryState>>;

const STATES = new Set<RegulationCategoryState>([
  'verified', 'verified_empty', 'unknown', 'incomplete', 'conflict',
]);

export function isRegulationCoverage(value: unknown): value is RegulationCoverage {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return REGULATION_CATEGORIES.every(key => typeof record[key] === 'string' && STATES.has(record[key] as RegulationCategoryState));
}

export function regulationCategoryOf(rule: { category?: string; type?: string } | null | undefined): RegulationCategory | null {
  if (!rule) return null;
  if (rule.category === 'cleaning' || rule.type === 'streetCleaning') return 'cleaning';
  if (rule.category === 'timeLimit' || rule.type === 'timeLimited') return 'timeLimits';
  if (rule.category === 'meter' || rule.type === 'meter') return 'meters';
  if (rule.category === 'restriction' || rule.type === 'noParking' || rule.type === 'noStanding'
    || rule.type === 'noStopping' || rule.type === 'curbRestrictionSet') return 'restrictions';
  return null;
}

export function coverageIsComplete(coverage: RegulationCoverage | null | undefined): boolean {
  if (!coverage) return false;
  return REGULATION_CATEGORIES.every(key => coverage[key] === 'verified' || coverage[key] === 'verified_empty');
}

/**
 * A responseVersion 1 verified payload names the rules it found. Categories
 * with no rule were not proven empty, so they stay unknown.
 */
export function coverageFromPresentedRules(
  rules: readonly { category?: string; type?: string }[],
): RegulationCoverage {
  const present = new Set(rules.map(regulationCategoryOf).filter(Boolean));
  return {
    cleaning: present.has('cleaning') ? 'verified' : 'unknown',
    restrictions: present.has('restrictions') ? 'verified' : 'unknown',
    timeLimits: present.has('timeLimits') ? 'verified' : 'unknown',
    meters: present.has('meters') ? 'verified' : 'unknown',
  };
}

export function unknownRegulationCoverage(): RegulationCoverage {
  return { cleaning: 'unknown', restrictions: 'unknown', timeLimits: 'unknown', meters: 'unknown' };
}

export function coverageForDisplayedRules(input: {
  segmentId?: string | null;
  curbProtocolVersion?: 2 | null;
  regulationStatus?: string | null;
  regulationCoverage?: unknown;
  publicRules?: readonly { category?: string; type?: string }[] | null;
}): RegulationCoverage | null {
  if (isRegulationCoverage(input.regulationCoverage)) return input.regulationCoverage;
  const canonical = input.curbProtocolVersion === 2
    || (input.segmentId || '').startsWith('curb2_')
    || input.regulationStatus != null;
  if (!canonical) return null;
  if (input.regulationStatus === 'verified' && Array.isArray(input.publicRules)) {
    return coverageFromPresentedRules(input.publicRules);
  }
  return unknownRegulationCoverage();
}
