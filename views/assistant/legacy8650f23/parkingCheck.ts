// Frozen client from 8650f239bc468ba54c1c4deaea4f93f7b7f42edb.
// Import paths are rewritten so this copy can render beside the current client.
// The decision logic is unchanged.
/**
 * "Am I Safe Here?" — combines what ParQueen already knows about a saved spot
 * into one conservative assessment.
 *
 * The question this answers is "is there anything I should worry about, given
 * the data we have?" It is explicitly NOT "is parking here legal?" — no branch
 * below can produce that claim, and the only optimistic outcome is the absence
 * of a known problem.
 *
 * Street-rule evaluation is not reimplemented here: callers pass in the result
 * of the existing computeSafeUntil / classifyStreetIntelligence pipeline.
 */

import type { SafeUntilResult } from '../../../utils/streetIntelligence';
import type { StreetIntelligencePresentationState } from '../../../utils/streetIntelligencePresentation';
import { type HydrantAssessment, isHydrantBlocking, isHydrantUncertain } from '../../../utils/hydrantDistance';

export type OverallStatus = 'move' | 'check' | 'no_known_issue';

export type StreetRuleStatus =
  | 'active_restriction'  // a restriction is running right now
  | 'clear'               // rules known, none active
  | 'side_unknown'        // we do not know which side the car is on
  | 'unavailable';        // no usable street data for this spot

export type ConfidenceLevel = 'high' | 'review';

export interface StreetRuleInput {
  /** From classifyStreetIntelligence. */
  presentation: StreetIntelligencePresentationState;
  /** From computeSafeUntil, or null when it could not be evaluated. */
  safeUntil: SafeUntilResult | null;
  /** From effectiveParkingSide — null means the side is not established. */
  effectiveSide: string | null;
  /** True when the lookup itself errored (network, permissions, provider). */
  failed?: boolean;
}

export interface ParkingCheckInput {
  street: StreetRuleInput;
  /** null when the hydrant check was not run at all. */
  hydrant: HydrantAssessment | null;
}

export interface ParkingCheckResult {
  overall: OverallStatus;
  street: StreetRuleStatus;
  hydrant: HydrantAssessment | null;
  confidence: ConfidenceLevel;
  /** Machine-readable reasons, most significant first. Used to build the copy. */
  reasons: string[];
}

export function evaluateStreetRules(input: StreetRuleInput): StreetRuleStatus {
  if (input.failed) return 'unavailable';
  if (input.presentation === 'unknown') return 'unavailable';
  if (!input.effectiveSide) return 'side_unknown';
  if (!input.safeUntil) return 'unavailable';
  if (input.safeUntil.activeNow) return 'active_restriction';
  return 'clear';
}

/**
 * Resolves the three inputs into one status.
 *
 * Precedence is deliberate: a known active problem outranks uncertainty, and
 * uncertainty outranks "nothing found". Anything unknown, stale, ambiguous or
 * failed lands on `check` — never on `no_known_issue`.
 */
export function evaluateParkingCheck(input: ParkingCheckInput): ParkingCheckResult {
  const street = evaluateStreetRules(input.street);
  const hydrant = input.hydrant;
  const reasons: string[] = [];

  // ── Known active problems ────────────────────────────────────────────────
  if (street === 'active_restriction') reasons.push('street_active_restriction');
  if (hydrant && isHydrantBlocking(hydrant)) reasons.push('hydrant_within_threshold');
  const mustMove = reasons.length > 0;

  // ── Things we could not establish ────────────────────────────────────────
  if (street === 'unavailable') reasons.push('street_unavailable');
  if (street === 'side_unknown') reasons.push('side_unknown');
  if (input.street.presentation === 'caution') reasons.push('street_needs_review');
  if (hydrant === null) reasons.push('hydrant_not_checked');
  else if (isHydrantUncertain(hydrant)) {
    reasons.push(hydrant.status === 'unavailable' ? 'hydrant_unavailable' : 'hydrant_too_close_to_call');
  }

  const uncertain = reasons.some(r => r !== 'street_active_restriction' && r !== 'hydrant_within_threshold');

  const overall: OverallStatus = mustMove ? 'move' : uncertain ? 'check' : 'no_known_issue';

  // Confidence describes the data behind the answer, not the answer itself.
  const confidence: ConfidenceLevel =
    input.street.presentation === 'supported'
    && street === 'clear'
    && hydrant !== null
    && !isHydrantUncertain(hydrant)
      ? 'high'
      : 'review';

  return { overall, street, hydrant, confidence, reasons };
}
