'use strict';

/**
 * Inventory of client reads that bypass the callable version gate.
 * Production firestore.rules are unchanged. The abbreviated rules below show
 * only the intended clause. The candidate that is tested against the complete
 * ruleset is buildStreetRulesClosedCandidate in streetRulesCandidate.js.
 * Replacing the two public reads requires an explicit founder decision.
 *
 * Denying streetRules reads stops a client from loading a published schedule
 * through Firestore. It does not delete a schedule already stored on the
 * device. Admin SDK readers in Cloud Functions are not affected.
 *
 * streetSegments documents currently carry ruleSummary.cleaningAvailable,
 * which is a boolean rather than the schedule. The proposed rules leave
 * segment reads open so nearest-segment lookup keeps working. That boolean
 * must not be treated as an actionable cleaning window.
 */
const STREET_RULES_CLIENTS = Object.freeze([
  Object.freeze({
    id: 'map-nearest-segment',
    file: 'views/StreetParkingView.tsx',
    reads: ['streetSegments geohash query', 'streetSegments/{id}/streetRules'],
    ifDenied: 'Nearest active segments can still be listed. Schedule counts and side schedules from Firestore stop. Empty-cache and restriction refresh already call createSegmentFromSweepNYC; that callable remains the publication path.',
  }),
  Object.freeze({
    id: 'my-car-fallback',
    file: 'views/street-parking/StreetIntelligenceCard.tsx',
    reads: ['streetSegments/{id}', 'streetSegments/{id}/streetRules'],
    ifDenied: 'My Car falls through to unknown when the saved spot has no publicRules array. A spot that already carries publicRules still renders from the device.',
  }),
  Object.freeze({
    id: 'parking-check-fallback',
    file: 'views/assistant/ParkingCheckTool.tsx',
    reads: ['streetSegments/{id}', 'streetSegments/{id}/streetRules'],
    ifDenied: 'Parking Check uses the saved publicRules when present. Without them it cannot load a Firestore schedule and stays unknown.',
  }),
  Object.freeze({
    id: 'saved-spot-open',
    file: 'views/StreetParkingView.tsx',
    reads: ['local pq_saved_spot', 'no curb refetch when curbProtocolVersion is 2'],
    ifDenied: 'Opening My Car does not replace a saved curb. An offline copy remains until the user updates the app.',
  }),
  Object.freeze({
    id: 'legacy-my-car',
    file: 'views/street-parking/legacy8650f23/StreetIntelligenceCard.tsx',
    reads: ['streetSegments/{id}/streetRules'],
    ifDenied: 'The frozen older client loses its Firestore schedule fallback. That is the installed app.parqueen path and is why these reads stay public until a founder approves the break.',
  }),
  Object.freeze({
    id: 'legacy-parking-check',
    file: 'views/assistant/legacy8650f23/ParkingCheckTool.tsx',
    reads: ['streetSegments/{id}/streetRules'],
    ifDenied: 'The frozen Parking Check loses the same fallback.',
  }),
  Object.freeze({
    id: 'admin-segment-list',
    file: 'views/admin/StreetSegmentsPage.tsx',
    reads: ['streetSegments', 'adminReadView streetScheduleList'],
    ifDenied: 'Segment discovery stays public. Schedule rows come from the Admin SDK view. The view must be deployed before the admin UI, and before the rules change.',
  }),
  Object.freeze({
    id: 'admin-health',
    file: 'views/admin/StreetIntelligenceHealthPage.tsx',
    reads: ['streetSegments documents', 'adminReadView streetIntelligenceHealth'],
    ifDenied: 'The active-rule count no longer uses collectionGroup. Borough rows still read public segment documents, which do not contain schedules.',
  }),
  Object.freeze({
    id: 'callable-persistence',
    file: 'functions/curbIntelligence/canonicalCurbPersistence.js',
    reads: ['Admin SDK streetSegments/{key}/streetRules'],
    ifDenied: 'Unchanged. Security rules do not apply to the Admin SDK.',
  }),
]);

const PROPOSED_STREET_RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /streetSegments/{segmentId} {
      allow read: if true;
      allow create, update, delete: if false;
      match /streetRules/{ruleId} {
        allow read: if false;
        allow create, update, delete: if false;
      }
    }
    match /{path=**}/streetRules/{ruleId} {
      allow read: if false;
      allow create, update, delete: if false;
    }
  }
}
`;

const STREET_RULES_CLIENT_ACCESS = Object.freeze({
  productionReadsRemainPublic: true,
  proposedRulesApplied: false,
  approval: 'founder',
  clients: STREET_RULES_CLIENTS,
  proposedRules: PROPOSED_STREET_RULES,
});

module.exports = {
  STREET_RULES_CLIENTS,
  PROPOSED_STREET_RULES,
  STREET_RULES_CLIENT_ACCESS,
};
