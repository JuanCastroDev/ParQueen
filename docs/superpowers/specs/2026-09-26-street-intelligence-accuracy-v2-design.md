# Street Intelligence Accuracy 2.0 Design

**Status:** Approved architecture; implementation specification  
**Date:** 2026-09-26  
**Starting point:** `origin/main` at `d39c55d3fd87dafe5bd39bffb48eba7581a60888`  
**Branch:** `feat/street-intel-accuracy`

## 1. Outcome

Street Intelligence must resolve one physical NYC curb before it evaluates any parking-rule source. The product contract is:

```text
bounded GPS sample burst
  -> canonical CSCL roadway side / Block Face ID
  -> rules associated to that same curb
  -> direct consumer answer, visual choice, or no verified answer
```

A wrong confident curb is a release blocker. The resolver must return `ambiguous` instead of choosing a crossing street, opposite curb, or materially overlapping candidate.

This phase does not add parking-rule categories, background tracking, retries, resolver capacity, resolver IAM, or a planimetric ingestion service.

## 2. Confirmed Current-System Failure Modes

The present mobile flow reverse-geocodes the saved coordinate through Mapbox while Street Intelligence independently selects the closest cached `streetSegments` center within 80 m. Cache reuse does not require the same street, block, side, or Block Face ID. On a miss, SweepNYC chooses a segment, OSM supplies centerline geometry, and the client infers a compass side. A client-side accuracy reading at or below 30 m can promote that heuristic side to `high` confidence.

Consequently, a saved address on White Plains Road and Street Intelligence on Maran Place can have two causes:

1. **Legitimate:** the postal address resolves to White Plains Road while the parked curb is geometrically on Maran Place.
2. **Incorrect:** the 80 m cache or source-specific lookup selects the crossing street independently of the parked curb.

The current meter and restriction work also starts before the private curb observation completes. It uses the production path's side and street context, so the sources are not guaranteed to describe one curb.

The current consumer card exposes provider names, update dates, review states, schedule counts, and confirmation metadata. Cleaning Alert defaults to enabled whenever a segment exists, even if the selected side has no usable cleaning schedule.

## 3. Authority Classification

| Current step | Classification | V2 treatment |
|---|---|---|
| Device GPS coordinates and reported accuracy | Supporting | Aggregate a bounded burst; never treat one reading as curb truth. |
| Mapbox postal reverse geocode | Supporting | Display address only; it may disagree with the curb street. |
| Client 80 m nearest-segment cache | Unsafe | Remove from new-save resolution. |
| SweepNYC segment selection and schedules | Legacy / supporting | Exact-curb corroboration or fallback only. |
| OSM centerline lookup | Heuristic | Remove from curb identity. It may remain outside V2 for unrelated map display. |
| CSCL geometry and left/right Block Face IDs | Authoritative identity | Canonical curb backbone. |
| Planimetric curb polylines | Supporting geometry | Corroborate physical curb proximity; never define identity alone. |
| GeoSupport Function 3C relationship | Authoritative relationship | Confirm a street/bounds/side tuple maps to the selected Block Face ID. |
| DOT current, non-voided parking signs | Authoritative regulation | Primary cleaning, prohibition, and time-limit source. |
| ParkNYC block-face data | Authoritative meter source | Primary meter hours, rates, and meter max-stay source. |
| Client compass-side chooser | Legacy emergency behavior | Replace normal use with visual curb selection. |
| `streetSegments/{id}` rules cache | Supporting | Re-key V2 documents by opaque canonical-curb key. |

## 4. Official Geometry Decision

NYC Planimetric Database: Curbs contains physical curb polylines and supports bounded Socrata spatial queries. It has no direct CSCL Block Face ID linkage, is updated as needed, and represents a slower-changing aerial-survey product. A bounded live query is operationally feasible, but a planimetric line cannot independently prove regulatory identity.

CSCL is the production identity source because it supplies current roadway geometry, constructed-roadway metadata, street width, and left/right Block Face IDs. Planimetric geometry is optional corroboration with a strict timeout. Missing planimetric data must not make an otherwise decisive CSCL result unavailable; conflicting or corner-like planimetric evidence may downgrade a result to `ambiguous`.

No offline planimetric ingestion or index is part of this phase.

## 5. Modules and Responsibilities

### Client

- `utils/locationBurst.ts`
  - Collects and aggregates 3–5 fresh samples over at most 1.8 seconds.
  - Exposes only the aggregate and diagnostics safe for local control flow.
  - Does not persist or emit raw samples.
- `utils/canonicalCurbClient.ts`
  - Defines the public callable request/response types.
  - Validates untrusted callable responses before they enter saved state.
- `views/street-parking/VisualCurbSelector.tsx`
  - Renders a compact Mapbox map with the saved position and two tappable curb strokes.
  - Uses opaque candidate tokens and display geometry only.
- `views/StreetParkingView.tsx`
  - Shows an immediate provisional saved state, runs one bounded resolution request, persists the final public result, and opens the selector only for an actionable ambiguity.
  - Stops querying the 80 m cache for new saves.
- `views/street-parking/StreetIntelligenceCard.tsx`
  - Renders product states only: verified answer, current restriction, or unable to verify.
  - Reports whether a usable cleaning deadline exists so reminder availability follows the actual rule result.
- `utils/savedSpot.ts`
  - Adds bounded lazy migration for V2 public fields while preserving legacy saves.

### Server

- `functions/curbIntelligence/curbResolutionPolicy.js`
  - Owns every numeric resolution threshold and maps internal evidence to `SUPPORTED`, `AMBIGUOUS`, or `UNSUPPORTED`.
- `functions/curbIntelligence/planimetricCurbAdapter.js`
  - Performs one bounded official curb-polyline query and returns normalized supporting geometry.
- `functions/curbIntelligence/canonicalCurbIdentity.js`
  - Constructs and validates the private identity and opaque public key/token.
- `functions/curbIntelligence/canonicalCurbOrchestrator.js`
  - Resolves CSCL candidates, applies intersection logic and optional planimetric corroboration, handles visual selection, and only then starts rule-source work.
- `functions/curbIntelligence/canonicalRuleSources.js`
  - Runs DOT, ParkNYC, and SweepNYC adapters against the resolved private identity.
- `functions/curbIntelligence/ruleConflictPolicy.js`
  - Selects one result per regulatory dimension and records conflicts without concatenating contradictions.
- `functions/curbIntelligence/canonicalCurbPersistence.js`
  - Persists the private identity in a server-only collection and public display/rule data under an opaque segment key.
- `functions/index.js`
  - Keeps `createSegmentFromSweepNYC` as the compatible deployed callable name, but delegates V2 requests to the canonical orchestrator.

The existing CSCL projection, confidence intervals, DOT parsing, ParkNYC association, restriction parsing, Safe Until calculation, suspensions, structured logging, rate limit, and request dedup logic are reused rather than replaced.

## 6. Private Canonical Identity

The following object exists only in server memory and the server-only `curbIdentities` collection:

```ts
interface CanonicalCurbIdentityV2 {
  schemaVersion: 2;
  jurisdiction: 'NYC';
  officialBlockFaceId: string;
  csclSide: 'LEFT' | 'RIGHT';
  sourceVersion: { resourceId: 'inkn-q76z'; version: string };
  roadway: {
    selectedGlobalId: string;
    supportingGlobalIds: string[];
    physicalId: string | null;
    b5sc: string | null;
    geometry: GeoJSON.MultiLineString;
    streetWidthFeet: number;
  };
  names: {
    borough: string;
    onStreet: string;
    fromStreet: string;
    toStreet: string;
    aliases: string[];
  };
  side: { cardinal: 'North' | 'South' | 'East' | 'West' };
  resolution: {
    method: 'automatic' | 'visual_selection';
    evidenceVersion: 'curb-v2';
  };
}
```

`officialBlockFaceId`, CSCL Global IDs, Physical ID, B5SC, sign IDs, and resolver details are never returned to the client or stored in client-readable documents.

The public key is `curb2_` plus a truncated SHA-256 digest over jurisdiction, normalized Block Face ID, and CSCL source identity. It is opaque and one-way; it becomes the public `segmentId`. Visual candidates use a separate digest over the public key, resolution request nonce, and candidate rank. Selection re-runs candidate resolution and accepts a token only when it matches a current candidate, so no private identifier is embedded in the token.

## 7. Public Callable Contract

The existing callable accepts a V2 request while retaining legacy validation:

```ts
type ResolveCurbRequestV2 = {
  protocolVersion: 2;
  location: {
    lat: number;
    lng: number;
    accuracyMeters: number;
    sampleCount: number;
    consistencyMeters: number;
  };
  postalStreetHint?: string;
  candidateToken?: string;
};

type ResolveCurbResponseV2 =
  | {
      protocolVersion: 2;
      status: 'high_confidence';
      segmentId: string;
      streetName: string;
      sideLabel: string;
      ruleSummary: { cleaningAvailable: boolean };
    }
  | {
      protocolVersion: 2;
      status: 'ambiguous';
      selector: {
        center: { lat: number; lng: number };
        candidates: [VisualCurbCandidate, VisualCurbCandidate];
      };
    }
  | {
      protocolVersion: 2;
      status: 'unsupported';
      reason: 'location_quality' | 'candidate_incomplete' | 'intersection_complex' | 'source_unavailable';
    };
```

`VisualCurbCandidate` contains an opaque token, street display name, and simplified GeoJSON stroke. It contains no Block Face ID, BFI, sign ID, raw row, source label, confidence score, or diagnostics.

Legacy calls without `protocolVersion: 2` keep their existing behavior during migration. V2 clients never fall back to the client 80 m chooser.

## 8. GPS Burst and Aggregate

On Save Car, the client seeds the burst with the most recent foreground map position only if it is at most 5 seconds old. It starts a temporary high-accuracy watch, stops at 5 valid samples or 1.8 seconds, and clears the watch in every terminal path. Three samples are the target minimum; one or two fresh samples may still be sent but cannot gain confidence merely from count.

Validation rejects samples with non-finite coordinates, invalid timestamps, reported accuracy outside 0–100 m, or age over 10 seconds.

Aggregation is deterministic:

1. Select the spatial medoid: the sample with the smallest sum of pairwise distances.
2. Compute median reported accuracy.
3. Reject a sample when its distance from the medoid exceeds `max(15 m, 2 * (sampleAccuracy + medianAccuracy))`.
4. Weight retained samples by `freshnessWeight / max(accuracyMeters, 3)^2`, where freshness weight decays linearly from 1.0 now to 0.5 at 10 seconds.
5. Compute the weighted latitude/longitude.
6. Set `consistencyMeters` to the maximum retained-sample distance from the aggregate.
7. Set aggregate `accuracyMeters` to `max(weighted reported accuracy, consistencyMeters, 3 m)`.

All constants live in `LOCATION_BURST_POLICY`. Raw samples remain only in function-local memory and are discarded after aggregation. No sample history is written to localStorage, Firestore, logs, analytics, or callable payloads.

## 9. CSCL Candidate Selection and Intersection Logic

The server queries official constructed, accessible CSCL roadway records within the existing uncertainty-derived envelope. Candidate completeness and source-version consistency remain mandatory.

Candidate grouping and projection use the existing geometry engine. For each roadway group, the resolver derives the selected CSCL side and its left/right Block Face ID.

The result is `SUPPORTED` only when all of the following hold:

- A normalized official Block Face ID exists.
- CSCL candidate coverage is complete and from one source version.
- Roadway status and accessibility are supported.
- The reported uncertainty plus model error does not cross the selected centerline.
- The best-roadway distance interval does not overlap the next material roadway interval.
- The point is farther from a component endpoint than the combined uncertainty, unless strict planimetric corroboration resolves the corner.
- The projected point lies within the segment component bounds.
- Street width makes the observation geometrically plausible.
- No multi-level, roadbed-grouping, or street-identity conflict remains.

`AMBIGUOUS` is returned when exactly two visually distinguishable curb candidates remain material after filtering. Material candidates include crossing roadways or opposite sides whose distance intervals overlap the aggregate uncertainty. Reverse-geocode street agreement, DOT signs, ParkNYC, and SweepNYC may corroborate a candidate but may never override conflicting geometry alone.

`UNSUPPORTED` is returned for incomplete candidate coverage, more than two unresolved material curbs, unusable GPS quality, missing official identities, off-network positions, or source failure that prevents a safe candidate set.

## 10. Planimetric Corroboration

The planimetric adapter runs in parallel with the CSCL candidate query under a 900 ms deadline, with no retry. It requests only a bounded radius and maximum row count. A curb line is usable only when its geometry is valid, locally close to the reported position, and its tangent is compatible with one CSCL candidate.

Planimetric evidence may:

- confirm that the selected point lies near the expected physical curb offset;
- distinguish two crossing-road candidates when one curb line is decisively closer after uncertainty intervals are applied;
- detect a corner return or inconsistent physical geometry and downgrade to ambiguous.

It may not create a Block Face ID, attach rules, overcome incomplete CSCL coverage, or upgrade a candidate when its mapping to a CSCL roadway side is not unique.

## 11. Central Confidence Policy

`curbResolutionPolicy.js` contains a frozen policy object and the only mapping from numeric evidence to states. Existing scattered client thresholds are deleted.

```js
const CURB_RESOLUTION_POLICY = Object.freeze({
  modelErrorMeters: 3,
  maxReportedAccuracyMeters: 50,
  minimumAutomaticSamples: 3,
  maxAutomaticConsistencyMeters: 12,
  endpointUncertaintyMultiplier: 1,
  planimetricDeadlineMs: 900,
  sourceDeadlineMs: 2500,
  maximumCsclCandidates: 100,
  maximumPlanimetricCandidates: 40,
});
```

State meanings:

- `SUPPORTED`: safe automatic curb identity; public status `high_confidence`.
- `AMBIGUOUS`: two safe selectable candidates; show the visual selector.
- `UNSUPPORTED`: no verified product answer; show calm unavailable copy.

Raw scores, intervals, reasons, and internal state names remain server-side and in privacy-safe categorical telemetry.

## 12. One-Curb Source Attachment

Rule lookup begins only after a `SUPPORTED` identity exists or the user has selected a currently valid visual candidate. All adapters consume the same private identity.

### DOT signs

Query current, non-voided `nfid-uabd` records using canonical borough, street, bounds, and side. Resolve the unique street/bounds/side tuple through the existing private Function 3C resolver once, and require the returned Block Face ID to equal the canonical identity before accepting the face. Parse cleaning, No Parking, No Standing, No Stopping, and time limits. Partial-face arrows or unsupported extents stay omitted unless existing reviewed logic proves whole-face applicability.

### ParkNYC

Use canonical geometry, street aliases, bounds, borough, and side. The existing geometric association remains fail-closed. Meter hours, fixed rates, and meter max stay are accepted only for the canonical curb.

### SweepNYC

SweepNYC is never allowed to choose the V2 curb. Its returned street, cross streets, and side must resolve through Function 3C to the same canonical Block Face ID. Only then is its schedule `exact-curb usable`.

SweepNYC roles:

1. Compare/corroborate a DOT cleaning schedule.
2. Record a conflict when its exact-curb schedule differs.
3. Provide a cleaning fallback only when DOT is technically unavailable or unparseable, not when a complete DOT query establishes no cleaning regulation.

No contradictory schedules are combined.

## 13. Conflict Policy

The conflict policy operates per canonical curb and regulatory dimension:

- DOT current/non-voided signs win for cleaning, prohibitions, and posted time limits.
- ParkNYC wins for meter hours, rates, and meter-specific max stay.
- Exact-curb SweepNYC may fill cleaning only under the fallback rule above.
- Reviewed ParQueen admin overrides retain their existing explicit authority and must name the same public canonical curb key.
- If two authoritative sources conflict on the same field without a documented semantic precedence, omit that field, retain unaffected rules, and emit `source_conflict`.
- Never concatenate contradictory schedule sets or show both.

Conflict telemetry contains only source categories, rule category, outcome, and count buckets.

## 14. Persistence and Cache Migration

V2 persistence is split:

- `curbIdentities/{publicCurbKey}`: server-only private identity and source metadata.
- `streetSegments/{publicCurbKey}`: client-readable display street, display side, public geometry if needed, status, timestamps, and no official identifiers.
- `streetSegments/{publicCurbKey}/streetRules/*`: selected public rules after conflict policy.

Server-side cache reuse requires the public key derived from the newly resolved private identity. Radius alone is never a cache key. Crossing-street and opposite-side documents therefore cannot satisfy the lookup.

Lazy migration is bounded:

- Existing saved sessions continue reading their legacy segment.
- A new save always resolves V2 and writes/reads the canonical document.
- A legacy saved session refresh resolves V2 once and replaces its public segment reference only after success.
- Compatible legacy rules may be copied only after street, bounds, side, and source relationship all match the private canonical identity. Otherwise they remain untouched and are not reused.
- Existing in-flight request dedup remains; no new retries are added.

## 15. Visual Curb Selector

The selector appears only for an actionable two-candidate ambiguity. It is a compact, mobile-first Mapbox panel centered on the aggregate saved position. The candidates are rendered as thick, contrasting curb strokes, with a car-position marker. Street names may label the strokes; compass directions, Block Face IDs, confidence, and GIS terminology are absent.

Touch behavior selects the nearest candidate stroke within a bounded pixel tolerance. An equivalent accessible control is provided for each candidate as “Curb along {street}.” The client sends the aggregate location plus opaque candidate token. The server re-runs resolution, verifies that token against the current candidate set, and persists the selected canonical identity with `method: visual_selection`.

If two candidates cannot be rendered as distinct tappable strokes, the result is unsupported. The legacy compass chooser is retained only behind debug/emergency code during migration and is not reachable in the normal V2 flow. Sign scanning remains an optional later fallback and is not invoked automatically.

## 16. Consumer UI and Cleaning Alert

The saved postal address remains in the My Car header. Street Intelligence displays the independently verified curb street. A mismatch is acceptable without explanation text when both labels are clear and geometry supports the curb.

Normal UI removes:

- Needs review and internal caution banners;
- source and freshness metadata;
- schedule counts;
- You confirmed;
- raw confidence and review language;
- implementation/debug terminology.

Product behavior expresses confidence:

- verified: show curb, Move By/Safe Until, cleaning, restrictions, time limits, and meters;
- active prohibition: show `PARKING RESTRICTED NOW` and the applicable restriction end;
- ambiguous: show visual selector;
- unsupported or insufficient rules: say ParQueen could not verify the curb/rules.

The card reports `cleaningAvailable` and `nextCleaningAt` separately from movement restrictions. Cleaning Alert is enabled and descriptive only when a usable future cleaning time exists for the selected canonical curb. Otherwise it is disabled/unavailable, promises no notification, and any active parking-session cleaning reminder is cleared or disabled. If a later refresh produces a usable schedule, normal preference behavior returns.

SAFE UNTIL continues to use movement restrictions only. Meter hours never affect SAFE UNTIL.

## 17. Privacy-Safe Telemetry

Add or retain these events:

- `curb_resolution_attempted`
- `curb_resolution_high`
- `curb_resolution_ambiguous`
- `curb_resolution_unsupported`
- `curb_candidate_count`
- `intersection_ambiguity`
- `visual_curb_selector_shown`
- `visual_curb_selected`
- `source_conflict`
- `street_name_conflict`
- `cache_curb_mismatch`

Allowed fields are protocol version, categorical reason, source category, rule category, candidate-count bucket, latency bucket, sample-count bucket, and boolean flags. Coordinates, exact street names, UID, public or private curb keys, BFI/Block Face IDs, CSCL IDs, sign/order IDs, raw rows, tokens, and raw error payloads are prohibited.

Measure total callable, resolver, CSCL, planimetric, relationship, and source latency by buckets. Record visual-fallback frequency without location data.

## 18. Performance and Failure Behavior

- The client shows a saved/resolving state immediately.
- GPS capture ends by 1.8 seconds.
- CSCL and optional planimetric queries run in parallel.
- After identity resolution, DOT, ParkNYC, and exact-curb SweepNYC work runs in parallel where safe.
- Existing source deadlines remain 2.5 seconds; planimetric uses 900 ms; the overall callable remains bounded by the existing 8 second shadow/product deadline.
- There are no retries or request fan-out loops.
- One V2 POST is expected per normal save; an ambiguous user selection authorizes one additional POST.
- A source failure omits that source while preserving known-good same-curb rules.
- Identity failure prevents all rule attachment and cache writes.

## 19. Test and Acceptance Matrix

`npm run test:street-intel` must include all new suites. Tests cover:

- straight residential street, opposite curb, wide avenue, narrow street;
- intersection corner, equidistant crossings, endpoint uncertainty, and crossing-street rejection;
- poor accuracy, 3–5 sample stabilization, timestamp weighting, outlier rejection, and bounded collection;
- postal street mismatch with geometrically correct curb;
- same-curb cache hit, opposite/crossing-curb cache rejection, and bounded legacy migration;
- DOT cleaning, ParkNYC meter, prohibitions, time limits, and stacked same-curb rules;
- wrong-side omission and source conflict precedence;
- DOT/SweepNYC agreement, disagreement, unavailable-DOT fallback, and no-coverage loss fixture set;
- high-confidence automatic flow, ambiguous visual flow, token revalidation, tap selection, accessibility, and no compass requirement;
- Cleaning Alert unavailable without a usable cleaning schedule and restored when one appears;
- absence of Needs review, source, schedule-count, You confirmed, and raw confidence copy in English and Spanish;
- SAFE UNTIL, active prohibition, daily schedules, suspensions, and meter non-participation regressions;
- request dedup, source deadlines, no retry storm, privacy telemetry payloads, and legacy saves.

Before deployment, run the Street Intelligence suite, focused Functions tests, TypeScript compilation, production build, and the broader unit suite. Known unrelated `mobileShell.contract.test.ts` and `tailwindCascade.test.ts` debt must be reported rather than hidden.

## 20. Rollout and Stop Conditions

Implementation remains behind the existing `CURB_PRODUCT_PATH=on` product boundary and keeps:

- `CURB_SHADOW_SAMPLE_PERMILLE=100`
- `CURB_RESOLVER_MODE=shadow`
- resolver `maxScale=1`
- resolver `concurrency=1`
- existing IAM and retry behavior

Deploy only changed Hosting and `createSegmentFromSweepNYC`/shared server modules after tests and code review. Do not deploy unrelated Functions, marketing Hosting, or Parsona work.

Stop before deployment if CSCL cannot deterministically identify a curb, planimetric evidence increases confident wrong-side risk, DOT-first loses substantial valid coverage without exact-curb fallback, selector candidates are not reliably distinguishable, privacy constraints require forbidden data, or latency becomes unacceptable.

Post-deploy verification must check Hosting and Mapbox health, callable health/revision, 5xx rate, one normal POST per save, telemetry queryability, unchanged Curb configuration and resolver state, no request explosion, cleaned consumer copy, Cleaning Alert consistency, legacy saves, and wrong-curb cache rejection. No synthetic production parking save is created; outdoor validation remains owner-operated.

## 21. Field Validation Items

The owner should validate at minimum:

1. Both sides of a straight residential block.
2. White Plains Road/Maran Place on each approach to the intersection.
3. A wide divided avenue and a narrow side street.
4. A location whose postal address street differs from the parked curb.
5. A deliberately ambiguous corner that opens the visual selector.
6. A curb with cleaning, meter, and prohibition stacking.
7. A curb with no cleaning schedule to confirm Cleaning Alert is unavailable.

