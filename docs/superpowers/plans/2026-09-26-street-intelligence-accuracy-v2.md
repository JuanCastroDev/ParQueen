# Street Intelligence Accuracy 2.0 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Resolve one canonical CSCL curb before attaching any parking rules, then present a verified answer, visual two-curb choice, or calm unavailable state.

**Architecture:** A bounded client GPS burst sends one V2 request to the existing callable. A server orchestrator resolves a private CSCL Block Face identity, optionally corroborates it with official planimetric curb geometry, runs all rule sources against that identity, persists public rules under an opaque key, and returns no private identifiers. Ambiguity is resolved through a compact visual selector whose token is revalidated server-side.

**Tech Stack:** React 18, TypeScript, Mapbox GL, Firebase callable Functions/Firestore, Node.js 22 CommonJS, Vitest, NYC Socrata APIs, existing private curb resolver.

**Spec:** `docs/superpowers/specs/2026-09-26-street-intelligence-accuracy-v2-design.md`

## Global Constraints

- CSCL left/right Block Face identity is canonical and remains server-side.
- Planimetric curb geometry is optional supporting evidence; no offline ingestion system.
- Collect 3–5 samples for at most 1.8 seconds; never persist raw sample history.
- Wrong confident curb is release-blocking; materially overlapping candidates return ambiguous.
- New saves never reuse cache data by 80 m radius alone.
- DOT current/non-voided signs are primary cleaning/restriction truth; ParkNYC is primary meter truth; SweepNYC is exact-curb corroboration/fallback.
- All rule sources consume the same canonical curb identity.
- No North/South/East/West question in the normal V2 flow.
- Keep sign scanning outside the normal flow.
- Preserve daily cleaning, meters, restrictions, SAFE UNTIL, active prohibitions, fail-soft sources, lazy migration, privacy, request dedup, and structured telemetry.
- Keep `CURB_PRODUCT_PATH=on`, `CURB_SHADOW_SAMPLE_PERMILLE=100`, `CURB_RESOLVER_MODE=shadow`, resolver `maxScale=1`, resolver `concurrency=1`, IAM, and retry behavior unchanged.
- Do not deploy before focused accuracy, intersection, cache, selector, regression, privacy, and performance checks pass.

## Review Focus

- A one- or two-sample burst must produce a usable aggregate but cannot qualify for automatic resolution; cover in Task 1.
- A stale visual candidate token after CSCL candidates change must be rejected without persisting anything; cover in Task 4.
- Street aliases and reversed cross-street order must still resolve the same canonical curb; cover in Task 5.
- Malformed planimetric geometry must be ignored or downgrade confidence, never throw or create an identity; cover in Task 3.
- A pre-V2 saved session must remain readable and perform at most one lazy canonical refresh; cover in Task 7.

---

### Task 1: Bounded Multi-Sample Location Capture

**Files:**
- Create: `utils/locationBurst.ts`
- Create: `utils/locationBurst.test.ts`
- Modify: `utils/geolocation.ts`
- Modify: `utils/geolocation.test.ts`

**Interfaces:**
- Consumes: existing `watchPosition(callback, error, options): LocationWatchHandle`.
- Produces: `aggregateLocationSamples(samples, nowMs): AggregatedLocation | null` and `collectLocationBurst(options): Promise<AggregatedLocation>`.
- `AggregatedLocation` contains only `lat`, `lng`, `accuracyMeters`, `sampleCount`, and `consistencyMeters`.

- [ ] **Step 1: Write failing aggregation tests**

Add tests named:

- `weights accurate fresh samples more heavily`
- `rejects a distant outlier`
- `returns a one-sample aggregate without inventing more samples`
- `rejects stale invalid and worse-than-100m samples`
- `uses the policy floor for aggregate accuracy`

Assert the exact algorithm and constants from spec section 8.

- [ ] **Step 2: Run aggregation tests and verify RED**

Run: `npx vitest run utils/locationBurst.test.ts`  
Expected: FAIL because `locationBurst.ts` does not exist.

- [ ] **Step 3: Implement the pure aggregation API**

Create:

```ts
export const LOCATION_BURST_POLICY: Readonly<{
  targetSamples: 5; minimumTargetSamples: 3; maximumDurationMs: 1800;
  maximumSeedAgeMs: 5000; maximumSampleAgeMs: 10000;
  maximumReportedAccuracyMeters: 100; accuracyFloorMeters: 3;
  minimumOutlierDistanceMeters: 15;
}>;

export function aggregateLocationSamples(
  samples: readonly LocationSample[],
  nowMs?: number,
): AggregatedLocation | null;
```

Use the medoid, outlier threshold, freshness/accuracy weighting, and aggregate uncertainty defined by the spec.

- [ ] **Step 4: Run aggregation tests and verify GREEN**

Run: `npx vitest run utils/locationBurst.test.ts`  
Expected: all tests PASS.

- [ ] **Step 5: Write failing bounded-collector tests**

Test that `collectLocationBurst`:

- stops on five valid samples;
- stops by 1.8 seconds;
- always clears its temporary watch;
- seeds only from a foreground sample no older than five seconds;
- does not log, persist, or return raw samples.

- [ ] **Step 6: Run collector tests and verify RED**

Run: `npx vitest run utils/locationBurst.test.ts utils/geolocation.test.ts`  
Expected: new collector tests FAIL.

- [ ] **Step 7: Implement the bounded collector**

Implement:

```ts
export async function collectLocationBurst(input: {
  seed?: LocationSample | null;
  now?: () => number;
  startWatch?: typeof watchPosition;
  setTimer?: typeof setTimeout;
  clearTimer?: typeof clearTimeout;
}): Promise<AggregatedLocation>;
```

No background watch, retry, or storage.

- [ ] **Step 8: Verify and commit**

Run: `npx vitest run utils/locationBurst.test.ts utils/geolocation.test.ts`  
Expected: PASS with zero failures.

Commit: `feat(street-intel): aggregate bounded GPS samples`

---

### Task 2: Canonical Identity and Central Confidence Policy

**Files:**
- Create: `functions/curbIntelligence/curbResolutionPolicy.js`
- Create: `functions/curbIntelligence/curbResolutionPolicy.test.js`
- Create: `functions/curbIntelligence/canonicalCurbIdentity.js`
- Create: `functions/curbIntelligence/canonicalCurbIdentity.test.js`
- Modify: `functions/curbIntelligence/confidence.js`

**Interfaces:**
- Consumes: `resolveOfficialCurb` evidence and normalized CSCL records.
- Produces: `classifyCanonicalCurb(evidence)`, `createCanonicalCurbIdentity(input)`, `publicCurbKey(identity)`, and `candidateToken(input)`.

- [ ] **Step 1: Write failing policy boundary tests**

Cover:

- exactly 50 m reported accuracy;
- more than 50 m;
- exactly three samples and 12 m consistency;
- fewer than three samples;
- crossing centerline uncertainty;
- overlapping roadway intervals;
- endpoint ambiguity;
- incomplete candidate coverage;
- two actionable candidates versus more than two.

- [ ] **Step 2: Verify policy tests fail**

Run: `npx vitest run functions/curbIntelligence/curbResolutionPolicy.test.js`  
Expected: FAIL because policy module is missing.

- [ ] **Step 3: Implement the centralized policy**

Export `CURB_RESOLUTION_POLICY` with the exact spec values and:

```js
function classifyCanonicalCurb(evidence) {
  // returns { state: 'SUPPORTED'|'AMBIGUOUS'|'UNSUPPORTED', reasons, candidates }
}
```

Delete no existing behavior yet; adapt `confidence.js` to consume the shared constants without changing its tested interval semantics.

- [ ] **Step 4: Verify policy tests pass**

Run: `npx vitest run functions/curbIntelligence/curbResolutionPolicy.test.js functions/curbIntelligence/curbResolver.test.js`  
Expected: PASS.

- [ ] **Step 5: Write failing identity privacy tests**

Assert:

- valid CSCL side selects the correct normalized Block Face ID;
- public key is deterministic and starts `curb2_`;
- opposite sides produce different keys;
- public projection contains no BFI, Block Face ID, Global ID, Physical ID, B5SC, sign ID, or source diagnostics;
- candidate tokens change with nonce/rank and reveal no private value.

- [ ] **Step 6: Implement identity constructors**

Create:

```js
function createCanonicalCurbIdentity(input)
function publicCurbKey(identity)
function createCandidateToken({ publicCurbKey, requestNonce, rank })
function toPublicCurb(identity)
```

Use SHA-256 digests; never serialize private identifiers into tokens.

- [ ] **Step 7: Verify and commit**

Run: `npx vitest run functions/curbIntelligence/curbResolutionPolicy.test.js functions/curbIntelligence/canonicalCurbIdentity.test.js functions/curbIntelligence/curbResolver.test.js`  
Expected: PASS.

Commit: `feat(street-intel): define canonical curb identity policy`

---

### Task 3: CSCL Intersection Resolution with Planimetric Corroboration

**Files:**
- Create: `functions/curbIntelligence/planimetricCurbAdapter.js`
- Create: `functions/curbIntelligence/planimetricCurbAdapter.test.js`
- Create: `functions/curbIntelligence/canonicalCurbResolver.js`
- Create: `functions/curbIntelligence/canonicalCurbResolver.test.js`
- Extend: `functions/curbIntelligence/nycResolverFixtures.test.js`
- Modify: `functions/curbIntelligence/runtimeCurbResolution.js`

**Interfaces:**
- Consumes: `createCsclCandidateStore`, geometry projection/grouping, Task 2 policy/identity, official planimetric resource `5xvt-8cbk`.
- Produces: `resolveCanonicalCurb(location, options)` returning private supported identity, two public selector candidates, or unsupported.

- [ ] **Step 1: Write failing planimetric adapter tests**

Assert bounded `within_circle` query, 40-row cap, 900 ms abort, MultiLine normalization, malformed-row rejection, and no retry. Include a malformed geometry fixture that returns incomplete evidence without throwing.

- [ ] **Step 2: Verify adapter tests fail**

Run: `npx vitest run functions/curbIntelligence/planimetricCurbAdapter.test.js`  
Expected: FAIL because adapter is missing.

- [ ] **Step 3: Implement the adapter**

Export:

```js
function createPlanimetricCurbStore(options = {})
function normalizePlanimetricCurbRow(row)
```

Return completeness and source version; never manufacture CSCL identity.

- [ ] **Step 4: Write failing canonical-resolution matrix**

Cover normal street, opposite curb, wide avenue, narrow street, intersection endpoint, equidistant crossing streets, crossing street a few meters closer, poor GPS, multi-level records, incomplete CSCL response, planimetric corroboration, planimetric conflict downgrade, and more-than-two candidates unsupported.

Assert White Plains Road/Maran Place-style fixtures select the geometric curb or return ambiguous, never the nearest crossing centerline by default.

- [ ] **Step 5: Verify resolution tests fail**

Run: `npx vitest run functions/curbIntelligence/canonicalCurbResolver.test.js functions/curbIntelligence/nycResolverFixtures.test.js`  
Expected: new assertions FAIL.

- [ ] **Step 6: Implement the resolver**

Implement:

```js
async function resolveCanonicalCurb(location, {
  candidateStore,
  planimetricStore,
  requestNonce,
  signal,
} = {})
```

Run CSCL and planimetric work in parallel. Apply planimetric evidence only under the strict tangent/distance association rules. Return exactly two candidates only when both have official identities and distinct display strokes.

- [ ] **Step 7: Verify and commit**

Run: `npx vitest run functions/curbIntelligence/planimetricCurbAdapter.test.js functions/curbIntelligence/canonicalCurbResolver.test.js functions/curbIntelligence/nycResolverFixtures.test.js functions/curbIntelligence/runtimeCurbResolution.test.js`  
Expected: PASS.

Commit: `feat(street-intel): resolve exact CSCL curbs at intersections`

---

### Task 4: Visual Selection Token Revalidation

**Files:**
- Create: `functions/curbIntelligence/visualCurbSelection.js`
- Create: `functions/curbIntelligence/visualCurbSelection.test.js`
- Modify: `functions/curbIntelligence/canonicalCurbResolver.js`

**Interfaces:**
- Consumes: Task 3 current candidate set and Task 2 token generator.
- Produces: `applyVisualCurbSelection({ location, candidateToken }, options)`.

- [ ] **Step 1: Write failing selection tests**

Assert valid token selects one private identity; wrong, replayed-rank, malformed, and stale-after-candidate-change tokens return unsupported; no invalid selection calls persistence or sources.

- [ ] **Step 2: Verify RED**

Run: `npx vitest run functions/curbIntelligence/visualCurbSelection.test.js`  
Expected: FAIL because selection module is missing.

- [ ] **Step 3: Implement re-resolution and token match**

Implement one fresh candidate resolution without retry. Match only current candidate tokens and stamp `resolution.method = 'visual_selection'`.

- [ ] **Step 4: Verify and commit**

Run: `npx vitest run functions/curbIntelligence/visualCurbSelection.test.js functions/curbIntelligence/canonicalCurbResolver.test.js`  
Expected: PASS.

Commit: `feat(street-intel): revalidate visual curb selections`

---

### Task 5: Same-Curb Rule Sources and Conflict Policy

**Files:**
- Create: `functions/curbIntelligence/canonicalDotLookup.js`
- Create: `functions/curbIntelligence/canonicalDotLookup.test.js`
- Create: `functions/curbIntelligence/canonicalSweepLookup.js`
- Create: `functions/curbIntelligence/canonicalSweepLookup.test.js`
- Create: `functions/curbIntelligence/canonicalRuleSources.js`
- Create: `functions/curbIntelligence/canonicalRuleSources.test.js`
- Create: `functions/curbIntelligence/ruleConflictPolicy.js`
- Create: `functions/curbIntelligence/ruleConflictPolicy.test.js`
- Modify: `functions/curbIntelligence/productMeterLookup.js`
- Modify: `functions/curbIntelligence/productRestrictionLookup.js`
- Reuse: `functions/curbIntelligence/officialDotRelationshipProvider.js`

**Interfaces:**
- Consumes: one private `CanonicalCurbIdentityV2`.
- Produces: `loadCanonicalRules(identity, options)` and `selectRuleSet(sourceResults)`.

- [ ] **Step 1: Write failing DOT exact-face tests**

Test one Function 3C tuple resolution per unique face, Block Face equality, current/non-voided filtering, reversed bounds, street aliases, cleaning/restrictions/time limits, wrong-side omission, partial-face omission, and source timeout.

- [ ] **Step 2: Verify DOT tests fail**

Run: `npx vitest run functions/curbIntelligence/canonicalDotLookup.test.js`  
Expected: FAIL.

- [ ] **Step 3: Implement canonical DOT lookup**

Implement:

```js
async function runCanonicalDotLookup({ identity, signal }, options)
```

Query and parse only after one resolver relationship equals the canonical Block Face ID.

- [ ] **Step 4: Write failing SweepNYC comparison/fallback tests**

Cover exact-curb relationship, DOT agreement, DOT conflict, DOT technical failure fallback, DOT complete/no-cleaning no fallback, and unverifiable SweepNYC omission.

- [ ] **Step 5: Implement exact-curb SweepNYC adapter**

Implement:

```js
async function runCanonicalSweepLookup({ identity, signal }, options)
```

It may return evidence; it may never select the identity.

- [ ] **Step 6: Write failing precedence tests**

Assert DOT cleaning/restrictions win, ParkNYC meter wins, exact-curb Sweep fills only allowed gaps, unresolved authoritative conflicts omit only the conflicting field, unaffected rules remain, and contradictory schedules never coexist.

- [ ] **Step 7: Implement conflict policy and source fan-out**

Implement:

```js
async function loadCanonicalRules(identity, options)
function selectRuleSet({ dot, parkNyc, sweepNyc, admin })
```

Start source work only after identity exists; run independent sources in parallel with current deadlines.

- [ ] **Step 8: Verify and commit**

Run: `npx vitest run functions/curbIntelligence/canonicalDotLookup.test.js functions/curbIntelligence/canonicalSweepLookup.test.js functions/curbIntelligence/canonicalRuleSources.test.js functions/curbIntelligence/ruleConflictPolicy.test.js functions/curbIntelligence/productMeterLookup.test.js functions/curbIntelligence/productRestrictionLookup.test.js`  
Expected: PASS.

Commit: `feat(street-intel): attach rules to one canonical curb`

---

### Task 6: Private Persistence, Exact Cache Identity, and Callable Orchestration

**Files:**
- Create: `functions/curbIntelligence/canonicalCurbPersistence.js`
- Create: `functions/curbIntelligence/canonicalCurbPersistence.test.js`
- Create: `functions/curbIntelligence/canonicalCurbOrchestrator.js`
- Create: `functions/curbIntelligence/canonicalCurbOrchestrator.test.js`
- Create: `functions/curbIntelligence/curbTelemetry.js`
- Create: `functions/curbIntelligence/curbTelemetry.test.js`
- Modify: `functions/index.js`
- Modify: `firestore.rules`
- Modify: relevant Firestore rules tests

**Interfaces:**
- Consumes: Tasks 3–5.
- Produces: `runCanonicalCurbOrchestrator(request, dependencies)` and V2 responses from `createSegmentFromSweepNYC`.

- [ ] **Step 1: Write failing persistence/security tests**

Assert private identities write only to `curbIdentities/{publicKey}`; public segment/rules contain no forbidden identifiers; client reads/writes to `curbIdentities` are denied; same identity reuses the same cache; opposite/crossing identity cannot reuse it; incompatible legacy cache emits mismatch and is not copied.

- [ ] **Step 2: Verify RED**

Run focused persistence and rules-unit tests.  
Expected: FAIL because V2 persistence and rules do not exist.

- [ ] **Step 3: Implement persistence and bounded migration**

Implement:

```js
async function readCanonicalCache({ db, publicCurbKey })
async function persistCanonicalCurb({ db, Timestamp, identity, selectedRules })
async function migrateCompatibleLegacyRules(input)
```

Require exact public key before reuse. Do not query or accept radius-only cache entries.

- [ ] **Step 4: Write failing orchestrator/callable tests**

Cover high, ambiguous, unsupported, valid visual selection, invalid selection, one normal source fan-out, no sources before identity, fail-soft source omission, request dedup, legacy protocol compatibility, and no retry.

- [ ] **Step 5: Implement orchestrator and callable routing**

Implement:

```js
async function runCanonicalCurbOrchestrator(request, dependencies)
```

Route `protocolVersion: 2` in the existing callable after current authentication/rate-limit validation. Keep legacy request behavior unchanged.

- [ ] **Step 6: Write failing telemetry privacy tests**

Assert every required event is allowed, every payload rejects coordinate/street/UID/key/BFI/ID/token/raw-row fields, candidate and latency values are bucketed, and logging failure cannot affect the response.

- [ ] **Step 7: Implement telemetry**

Export categorical event constants, payload allowlist validation, latency buckets, and a fail-soft logger.

- [ ] **Step 8: Verify and commit**

Run: `npx vitest run functions/curbIntelligence/canonicalCurbPersistence.test.js functions/curbIntelligence/canonicalCurbOrchestrator.test.js functions/curbIntelligence/curbTelemetry.test.js functions/curbIntelligence/privateResolverCallableComposition.test.js functions/streetIntelRefresh.test.js` plus focused rules tests.  
Expected: PASS.

Commit: `feat(street-intel): orchestrate and cache canonical curbs`

---

### Task 7: V2 Client Contract, Immediate Save State, and Lazy Migration

**Files:**
- Create: `utils/canonicalCurbClient.ts`
- Create: `utils/canonicalCurbClient.test.ts`
- Modify: `utils/savedSpot.ts`
- Modify: `utils/assistantTools.test.ts`
- Modify: `views/StreetParkingView.tsx`
- Create or extend: `views/street-parking/StreetParkingView.streetIntel.test.tsx`

**Interfaces:**
- Consumes: Task 1 aggregate and Task 6 V2 callable.
- Produces: validated V2 client states and `SavedSpot` V2 fields.

- [ ] **Step 1: Write failing response-validation tests**

Assert accepted high/ambiguous/unsupported responses; reject malformed geometry, more or fewer than two candidates, private identifier fields, invalid segment keys, invalid tokens, and unknown statuses.

- [ ] **Step 2: Implement response validation**

Export:

```ts
export function parseCanonicalCurbResponse(value: unknown): CanonicalCurbResponse;
export function buildCanonicalCurbRequest(location: AggregatedLocation, candidateToken?: string): ResolveCurbRequestV2;
```

- [ ] **Step 3: Write failing save-flow and migration tests**

Assert:

- the saved/resolving UI appears before burst/callable completion;
- one normal save issues one V2 callable request;
- ambiguous selection permits one additional request;
- no client 80 m Firestore query runs for V2;
- postal address and curb street persist separately;
- a pre-V2 saved spot reads successfully;
- legacy refresh runs at most once and replaces the segment only on V2 high confidence;
- unsupported result persists no invented side or segment.

- [ ] **Step 4: Verify RED**

Run: `npx vitest run utils/canonicalCurbClient.test.ts utils/assistantTools.test.ts views/street-parking/StreetParkingView.streetIntel.test.tsx`  
Expected: new tests FAIL.

- [ ] **Step 5: Implement client integration**

Add `curbProtocolVersion`, `curbResolutionStatus`, and optional selector state to `SavedSpot`. Replace new-save `runMatchNearestSegment` with the GPS burst plus one V2 callable. Preserve the legacy read/retry path only for existing saved sessions.

- [ ] **Step 6: Verify and commit**

Run: `npx vitest run utils/locationBurst.test.ts utils/canonicalCurbClient.test.ts utils/assistantTools.test.ts views/street-parking/StreetParkingView.streetIntel.test.tsx`  
Expected: PASS.

Commit: `feat(street-intel): resolve canonical curb on save`

---

### Task 8: Compact Visual Curb Selector

**Files:**
- Create: `views/street-parking/VisualCurbSelector.tsx`
- Create: `views/street-parking/VisualCurbSelector.test.tsx`
- Modify: `views/StreetParkingView.tsx`
- Modify: application stylesheet containing My Car Street Intelligence styles

**Interfaces:**
- Consumes: validated two-candidate selector contract from Task 7.
- Produces: `onSelect(candidateToken: string)`; never emits a compass direction.

- [ ] **Step 1: Write failing component tests**

Assert two highlighted strokes, saved-car marker, street labels, tap/click nearest-stroke selection, two accessible “Curb along {street}” controls, no cardinal-direction prompt, no GIS identifiers, loading lockout, and unavailable fallback when strokes are not distinct.

- [ ] **Step 2: Verify RED**

Run: `npx vitest run views/street-parking/VisualCurbSelector.test.tsx`  
Expected: FAIL because component is missing.

- [ ] **Step 3: Implement the selector**

Render a small Mapbox instance using existing token/theme utilities. Fit tightly to point plus two strokes. Clean up map/listeners on unmount. Keep the interaction inside the existing My Car sheet.

- [ ] **Step 4: Integrate selection flow**

On selection, submit the token through Task 7, replace ambiguous state only after a validated high-confidence response, and leave the user in a calm retry/unavailable state on failure. Keep the old compass picker unreachable in V2 normal flow.

- [ ] **Step 5: Verify and commit**

Run: `npx vitest run views/street-parking/VisualCurbSelector.test.tsx views/street-parking/StreetParkingView.streetIntel.test.tsx`  
Expected: PASS.

Commit: `feat(street-intel): add visual curb selection`

---

### Task 9: Consumer Card Cleanup and Cleaning Alert Consistency

**Files:**
- Modify: `views/street-parking/StreetIntelligenceCard.tsx`
- Modify: `views/street-parking/StreetIntelligenceCard.test.tsx`
- Modify: `views/StreetParkingView.tsx`
- Modify: `i18n/en.ts`
- Modify: `i18n/es.ts`
- Modify: `i18n/streetIntelCopyParity.test.ts`
- Create or extend: `i18n/streetIntelligenceConsumerCopy.test.ts`

**Interfaces:**
- Consumes: verified public segment/rules.
- Produces: `onResult({ movementResult, cleaningAvailable, nextCleaningAt })` and clean consumer presentation.

- [ ] **Step 1: Write failing consumer-copy tests**

Assert normal rendered output contains none of:

- Needs review;
- provider/source labels;
- update metadata;
- schedule counts;
- You confirmed;
- raw confidence/review terminology.

Assert English/Spanish keys have parity and unsupported copy says only that ParQueen could not verify the curb/rules.

- [ ] **Step 2: Write failing reminder tests**

Cover:

- no cleaning schedule plus meter/restriction means Cleaning Alert disabled and no promise copy;
- active prohibition without cleaning does not enable Cleaning Alert;
- a usable future cleaning schedule enables it;
- later refresh from unavailable to usable restores the preference behavior;
- disabling/unavailable clears or deactivates the parking-session cleaning reminder;
- SAFE UNTIL and active prohibition behavior remain unchanged;
- meters never affect SAFE UNTIL.

- [ ] **Step 3: Verify RED**

Run: `npx vitest run views/street-parking/StreetIntelligenceCard.test.tsx i18n/streetIntelCopyParity.test.ts i18n/streetIntelligenceConsumerCopy.test.ts`  
Expected: new assertions FAIL.

- [ ] **Step 4: Simplify the card and split result channels**

Remove metadata/chips/caution UI from normal output. Preserve debug-only diagnostics behind the existing debug mode. Return cleaning availability independently from the movement result.

- [ ] **Step 5: Fix Cleaning Alert state**

Disable the tile and promise copy without a usable cleaning time. Prevent writes/scheduling without `nextCleaningAt`. Restore the saved preference when a later card result supplies a usable time.

- [ ] **Step 6: Verify and commit**

Run: `npx vitest run views/street-parking/StreetIntelligenceCard.test.tsx i18n/streetIntelCopyParity.test.ts i18n/streetIntelligenceConsumerCopy.test.ts utils/streetIntelligence.test.ts utils/streetIntelMeter.test.ts`  
Expected: PASS.

Commit: `fix(street-intel): simplify card and gate cleaning alerts`

---

### Task 10: Unified Suite, Performance Gates, Review, and Release

**Files:**
- Modify: `package.json`
- Extend: `utils/streetIntelRelease.test.ts`
- Add or update: focused release documentation as needed

**Interfaces:**
- Consumes: all previous tasks.
- Produces: one complete `npm run test:street-intel` gate and evidence for the required report.

- [ ] **Step 1: Add every new suite to `test:street-intel`**

Keep one command that includes GPS, identity, intersections, planimetric, source conflicts, cache, telemetry, client contract, selector, card, i18n, and prior 2A.27–2A.31 regression files.

- [ ] **Step 2: Add static release-contract tests**

Assert:

- V2 new-save flow contains no 80 m cache selection;
- all source lookup is downstream of canonical resolution;
- no private identifier appears in public serializers or client interfaces;
- no new retry loop exists;
- required production config strings remain unchanged;
- compass chooser is not reachable from V2 normal flow.

- [ ] **Step 3: Run focused verification**

Run: `npm.cmd run test:street-intel`  
Expected: all listed test files PASS, zero failures.

Run: `npx tsc --noEmit`  
Expected: exit 0.

Run: `npm.cmd run build`  
Expected: exit 0.

- [ ] **Step 4: Run broader regression verification**

Run: `npm.cmd test`  
Expected: record complete pass/fail counts. If only known unrelated `mobileShell.contract.test.ts` or `tailwindCascade.test.ts` debt fails, report it accurately; any Street Intelligence or newly caused failure blocks release.

- [ ] **Step 5: Measure bounded behavior**

Use deterministic tests/fakes to record GPS burst maximum, planimetric/source deadlines, total callable bucket, one normal POST, one optional selection POST, and no retry/request explosion. Do not generate a production parking save.

- [ ] **Step 6: Request code review and fix all Critical/Important findings**

Review the full diff against the spec, especially confident-wrong-side risks, privacy boundaries, selector reliability, and source precedence. Re-run affected tests after each fix.

- [ ] **Step 7: Commit release gate**

Commit: `test(street-intel): gate accuracy v2 release`

- [ ] **Step 8: Push and open PR**

Push `feat/street-intel-accuracy`, open a PR to `main`, attach it to the task, and wait for required checks/review. Do not merge while any accuracy, intersection, cache, selector, privacy, or performance gate is failing.

- [ ] **Step 9: Merge and deploy only validated components**

After review/checks, merge per repository policy. Deploy app Hosting and `createSegmentFromSweepNYC` plus shared server modules only. Do not deploy unrelated Functions, marketing Hosting, resolver IAM/scale, or Parsona work.

- [ ] **Step 10: Perform post-deploy verification**

Verify Hosting 200, Mapbox 200, callable health/revision, no 5xx increase, expected request count, queryable telemetry, unchanged Curb config/resolver state, cleaned UI copy, Cleaning Alert consistency, legacy-save compatibility, and exact-cache behavior. Stop without synthetic production saves; list outdoor field-validation items for the owner.

