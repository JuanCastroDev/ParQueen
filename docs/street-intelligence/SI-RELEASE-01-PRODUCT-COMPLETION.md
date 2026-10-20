# SI-RELEASE-01 — Street Intelligence product completion

Audit baseline: committed `main` at `a1db518fd31b9a88fc6424b9ce55939074d56cf6`.

Audit worktree: `C:\Users\jayca\GitWorktrees\ParQueen-si-release-01`.

Audit branch: `codex/si-release-01-product-completion`.

This document is the product-release boundary. It does not change benchmark design, sampling, scoring, or `functions/curbIntelligence/**`.

## Release and benchmark are separate

`SI_LAUNCH_03_BLOCKS_PRODUCT_COMPLETION = FALSE`

`SI_LAUNCH_03_BLOCKS_APP_RELEASE_AUTOMATICALLY = FALSE`

`PROSPECTIVE_PERFORMANCE_CLAIMS_ALLOWED = FALSE`

SI-LAUNCH-03 remains `WAITING_FOR_SOURCE_CONSISTENCY`. The latest readiness observation is catalog `26B`, metadata `26C`, package `26B`, node `26B`. No prospective challenge set exists. No prospective scoring occurred. `PARQUEEN_PROSPECTIVE_ACCURACY_INFORMATION_LEARNED = NONE`.

That source mismatch is independent validation work. It is not a product P0.

No release copy may say or imply a measured prospective accuracy, coverage, or block-side count from that study. Shipping a fail-closed Street Intelligence feature is allowed. Shipping a performance claim is not.

## Frozen core

Canonical authority core remains frozen at `ac788490e4f0d103b3dc06c91fccd35d7c7f9afd` (`Require Function 3C curb identity proof`).

That commit is in the SI-LAUNCH repository. It is not an object in the ParQueen product repository. At the product baseline, `functions/curbIntelligence/canonicalCurbResolver.js` is blob `dc1f8a8c2ab11475218d4047c5f2037642fa52c1`. At `ac788` the same path is blob `17c0c1c75bc89ffdf2407df811aa689bc0c788f8`. The product tree has no `proveCanonicalCurbIdentity`.

Do not edit the frozen core to make integration easier. The product must call that core. The next phase ports the frozen modules onto this product branch without weakening:

- `TOPOLOGY_PRIMARY_REQUIRED`
- `FUNCTION3C_VALID_IDENTITY_REQUIRED`
- `EXACT_BFI_EQUALITY_REQUIRED`
- `BFI_MISMATCH_FAILS_CLOSED`
- `FUNCTION3C_BFI_UNAVAILABLE_FAILS_CLOSED`
- `FUNCTION3C_CONTRACT_FAILURE_FAILS_CLOSED`
- `FUNCTION3C_CANNOT_RESCUE_UNPROVEN_TOPOLOGY`
- `CACHE_CANNOT_BYPASS_FUNCTION3C_PROOF`
- `PERSISTENCE_CANNOT_BYPASS_FUNCTION3C_PROOF`
- `VISUAL_SELECTION_CANNOT_BYPASS_FUNCTION3C_PROOF`
- `FUNCTION3C_PROOF_PRECEDES_BFI_DEPENDENT_SIDE_EFFECTS`
- `CANONICAL_FUNCTION3C_PROOF_CALL_COUNT = 1`
- `NO_BENCHMARK_LEAKAGE`

## Fail-closed release rule

A user-visible parking answer requires one successful canonical Function 3C proof for that resolution. Missing topology, ambiguous topology, unavailable proof, invalid proof, BFI mismatch, contract failure, timeout, network failure, and a malformed payload stay non-answers. Cache, persistence, visual selection, and the cleaning card cannot create or restore an answer the proof did not authorize.

## Actual product architecture

Committed call chain for My Car save:

1. `saveMySpot` and `saveMySpotFromCoords` in `views/StreetParkingView.tsx` call `requestCanonicalCurb`.
2. `requestCanonicalCurb` calls `resolveCanonicalCurbWithLocation` in `utils/canonicalCurbClient.ts`.
3. The client sends `protocolVersion: 2` to the callable `createSegmentFromSweepNYC` (`functions/index.js`).
4. `selectCanonicalV2Handler` routes protocol 2 to `_runCanonicalCurbV2`.
5. `_runCanonicalCurbV2` returns `unsupported` / `source_unavailable` unless `CURB_RESOLVER_MODE=shadow` and `CURB_PRODUCT_PATH=on`. Both are set in `functions/.env.parkqueen-46475363-ccf36`. Code defaults are `off`.
6. When the gate is on, `runCanonicalCurbOrchestrator` calls `resolveCanonicalCurb`.
7. `resolveCanonicalCurb` ranks CSCL roadway geometry and `classifyCanonicalCurb`. `SUPPORTED` carries `createCanonicalCurbIdentity` from the CSCL block-face id. It does not call Function 3C.
8. After `SUPPORTED`, the orchestrator may read `curbIdentities/{key}` and `streetSegments/{key}`, load rules, and `persistCanonicalCurb`.
9. The client stores the public response on the local saved spot. `high_confidence` renders `StreetIntelligenceCard`. `ambiguous` renders `VisualCurbSelector`. `unsupported` renders the non-answer retry state.

`applyVisualCurbSelection` re-runs that same unproven resolver and promotes a matching candidate token to `SUPPORTED`.

`privateBlockfaceResolver` is a Geosupport-style client used by sweep, DOT, and rule helpers. It is not the frozen `proveCanonicalCurbIdentity`, and `resolveCanonicalCurb` does not call it before `SUPPORTED`.

| Surface | Classification | Evidence |
| --- | --- | --- |
| Callable boundary | COMPLETE | `exports.createSegmentFromSweepNYC` |
| Client invocation for My Car | COMPLETE | `requestCanonicalCurb` → protocol 2 |
| Location gate | COMPLETE | `isCanonicalLocationReady`; client returns `location_quality` |
| Topology authority | PARTIAL | CSCL geometry plus policy; not the frozen topology-primary proof |
| Function 3C proof | NOT_WIRED | module absent from this commit |
| Cache and persistence | PARTIAL | after unproven `SUPPORTED` |
| Firestore rules for curb identity | COMPLETE | `curbIdentities` client read/write denied |
| Public segment reads | COMPLETE | `streetSegments` and `streetRules` world-readable, client writes denied |
| UI presentation | PARTIAL | protocol states render; proof failures are not distinct |
| Visual selection | PARTIAL | wired, then treated as authority |
| Safe Until / cleaning card | PARTIAL | renders after a segment id exists |
| Alternate-side product | NOT_APPLICABLE | no separate ASP flow; cleaning is the card |
| Feature gate | COMPLETE | `CURB_PRODUCT_PATH` / `CURB_RESOLVER_MODE` |
| App Check on this callable | NOT_WIRED | options omit `enforceAppCheck` |
| Auth and rate limit | COMPLETE | sign-in required; 30 calls / hour |
| Observability | PARTIAL | curb telemetry has attempt, high, ambiguous, unsupported, cache mismatch, latency buckets; no proof-specific events |
| Deployment of the live revision | UNKNOWN_PRODUCTION_STATE | repo contains code and params; this audit did not query production |

## Wiring

`STREET_INTELLIGENCE_PRODUCTION_CALLABLE_EXISTS = TRUE`

`CLIENT_CALLS_STREET_INTELLIGENCE_PRODUCTION_PATH = TRUE`

`FROZEN_CORE_REACHABLE_FROM_REAL_USER_FLOW = FALSE`

`AUTHORITATIVE_RESULT_REACHES_UI = FALSE`

`FAIL_CLOSED_RESULT_REACHES_UI = TRUE`

The missing wiring is the frozen proof. `canonicalCurbOrchestrator.js` in the product tree goes from resolver `SUPPORTED` to cache and persistence. The frozen orchestrator calls `proveCanonicalCurbIdentity` before `readCanonicalCache` and `persistCanonicalCurb`. That call is absent here, so a high-confidence card is not a Function 3C answer.

Fail-closed UI does exist for the protocol the client understands. Location failure, a thrown callable, and an invalid payload become `unsupported` / `source_unavailable` or `location_quality`, clear the segment id, and show `street_intel.could_not_verify` with retry. They do not invent a curb. Function 3C mismatch, invalid proof, and proof-unavailable are not separate states because the proof never runs.

## Authority bypass

| Finding | Severity |
| --- | --- |
| `resolveCanonicalCurb` can return `SUPPORTED` from CSCL distance, side, and policy with no Function 3C proof | P0 |
| Cache read and `persistCanonicalCurb` run on that unproven identity | P0 |
| `StreetIntelligenceCard` and cleaning reminders run once `segmentId` and `segmentStreetName` are stored | P0 |
| `applyVisualCurbSelection` converts a candidate token into `SUPPORTED` after a second unproven resolution | P0 |
| Requests without `protocolVersion: 2` still execute `_tryCreateFromSweepNYC` / NYC Open Data and can return `success: true` | P0 |
| `readCanonicalCache` treats key equality as a hit. No TTL. No proof binding | P1 |
| `createSegmentFromSweepNYC` does not set `enforceAppCheck: true` | P1 |

The legacy client matcher `matchNearestSegment` is only reached from debug `simulateMyCarSave`. The shipped `saveMySpot` path does not call it. The server branch is still reachable by any signed-in caller.

## Cache and persistence

Object: `curbIdentities/{publicCurbKey}` plus `streetSegments/{publicCurbKey}` and `streetRules`.

- Prerequisite today: resolver `SUPPORTED`. Required prerequisite: one Function 3C proof.
- Key: `publicCurbKey(identity)`, pattern `curb2_` plus 32 hex characters.
- TTL: none.
- Source, protocol, and BFI binding on read: public key equality and `segmentId` equality only.
- Provenance: private identity document is server-only. Public segment carries the public curb fields and `ruleSummary.cleaningAvailable`.
- Stale behavior: a matching key is a hit until overwritten.
- Invalidation: mismatch reason `cache_curb_mismatch` only.

`CACHE_CANNOT_BYPASS_FUNCTION3C_PROOF = FALSE` on this baseline.

`PERSISTENCE_CANNOT_BYPASS_FUNCTION3C_PROOF = FALSE` on this baseline.

Saved-spot state in local storage is a client projection of the callable response. It is not a second authority. A reload shows the last stored public fields; retry calls the callable again.

## Firestore and security

Collections: `curbIdentities`, `streetSegments`, `streetSegments/{id}/streetRules`.

Server writes the canonical documents through the Admin SDK in `persistCanonicalCurb`. Clients cannot write them. Clients can read segments and rules. Clients cannot read `curbIdentities`.

The callable requires Firebase Auth and a per-user rate limit. It does not enforce App Check. The committed private-preferences rule change in the dirty app worktree is unrelated; it is not part of this baseline.

No production deploy and no rules deploy were performed.

## Observability

Present when the v2 gate runs: `curb_resolution_attempted`, `curb_resolution_high`, `curb_resolution_ambiguous`, `curb_resolution_unsupported` (with public reason and `failureDetail`), `cache_curb_mismatch`, and latency buckets.

Absent: Function 3C unavailable, invalid, mismatch, and contract-failure events, and a cache hit/miss that is conditional on proof. Do not add analytics for its own sake. Add those four proof outcomes to the existing structured curb log when the frozen core is wired.

## Product test matrix

| Case | Status |
| --- | --- |
| Authoritative success through Function 3C | NO_TEST |
| Safe abstention for protocol `unsupported` | PASSING_TEST_EXISTS |
| Topology ambiguity UI and selector | PASSING_TEST_EXISTS |
| Function 3C unavailable / invalid / mismatch | NO_TEST |
| Cache after valid proof | NO_TEST |
| Cache cannot bypass proof | NO_TEST |
| Persistence cannot bypass proof | NO_TEST |
| Stale cache | NO_TEST |
| Network failure and malformed response mapped to non-answer | PASSING_TEST_EXISTS |
| App restart of a stored spot | PARTIAL_TEST |
| Auth failure | PARTIAL_TEST |
| App Check failure | NO_TEST |
| Location denied / low quality | PASSING_TEST_EXISTS |
| Multiple rapid saves | PARTIAL_TEST |
| Offline recovery | PARTIAL_TEST |
| UI withholds a segment on non-answer | PASSING_TEST_EXISTS |

Existing tests cover the unproven protocol. They do not prove the frozen core.

## Deployment reality

| Component | State |
| --- | --- |
| `createSegmentFromSweepNYC` source and `CURB_*` params in repo | CODE_EXISTS_NOT_DEPLOYED as evidence of source only |
| Live Cloud Function revision and Cloud Run resolver revision | UNKNOWN_PRODUCTION_STATE |
| Frozen core image | NOT_REQUIRED until the product branch contains that core |
| SI-LAUNCH benchmark workers | NOT_REQUIRED for product completion |

This phase did not query production.

## Pending app diff

`PENDING_APP_DIFF_AFFECTS_SI_RELEASE_AUDIT = FALSE`

Read-only inspection of the dirty `main` worktree found analytics-only edits in `views/StreetParkingView.tsx` and `views/street-parking/useInterestFlow.ts`, plus an `analyticsConsent` field on the user private-preferences rule. Class `PENDING_UNCOMMITTED_APP_CHANGE` / A. Those edits do not change the curb callable, the resolver, cache, persistence, or curb rules. They were not copied here.

## Smallest remaining backlog

### P0 release blockers

1. Put the frozen `ac788` authority on the product v2 path. `proveCanonicalCurbIdentity` must run once after topology selection and before cache, persistence, visual promotion, and any BFI-dependent UI. Do not rewrite the core.
2. Stop `createSegmentFromSweepNYC` from returning a legacy `success: true` parking answer for requests that are not protocol 2. The shipped My Car save already uses protocol 2. The server branch is still a bypass.

### P1 before release

1. Enforce App Check on `createSegmentFromSweepNYC`.
2. Bind cache hits to the proof protocol and source version, with an explicit TTL or equivalent invalidation. Key equality alone is not freshness.
3. Add product tests for proof success, proof abstention, cache/persistence bypass, and the fail-closed card.
4. Deploy the resulting function revision on purpose and smoke the signed-in My Car save. Repository params are not evidence that production is current.

### P2 follow-up

1. Remove the debug-only `matchNearestSegment` legacy client path.
2. Keep `confirmedParkingSide` as a local label. It must not satisfy the proof.

### Validation only

1. SI-LAUNCH-03 source consistency. Not a product blocker.

`P0_COUNT = 2`

`P1_COUNT = 4`

`P2_COUNT = 2`

`VALIDATION_ONLY_COUNT = 1`

## STREET_INTELLIGENCE_PRODUCT_COMPLETE

The predicate is true only when every line below is true. SI-LAUNCH-03 completion is not one of them.

1. The shipped My Car save, handoff save, visual reselection, and retry call protocol 2 on `createSegmentFromSweepNYC`.
2. `functions/curbIntelligence/canonicalCurbResolver.js`, `canonicalCurbIdentityProof.js`, `canonicalCurbOrchestrator.js`, `visualCurbSelection.js`, and `canonicalCurbPersistence.js` match `ac788490e4f0d103b3dc06c91fccd35d7c7f9afd`. `functions/index.js` calls that orchestrator for protocol 2. No other edit inside `functions/curbIntelligence/**` is part of this release.
3. Canonical resolution calls Function 3C exactly once, and only after topology is primary.
4. Cache, persistence, visual selection, and the cleaning card cannot run from an unproven identity.
5. Topology failure, proof failure, timeout, network failure, malformed payload, denied location, and low-quality location render a non-answer and a retry, with no fabricated curb.
6. `curbIdentities` stay server-only. Segment writes stay server-only. The callable requires auth, App Check, and the existing rate limit.
7. Structured logs distinguish attempt, authoritative success, safe abstention, topology unavailable, topology ambiguous, Function 3C unavailable, Function 3C invalid, BFI mismatch, contract failure, cache hit, cache miss, and unexpected exception.
8. The product test matrix rows above are green on the wired path.
9. The function revision and params are the deployed revision. A signed-in smoke save shows one authoritative success and one forced non-answer.
10. Critical findings are 0. High release blockers are 0.
11. No prospective accuracy, coverage, or block-side claim is present.

`STREET_INTELLIGENCE_PRODUCT_COMPLETE = FALSE` at this baseline.

## Next implementation phase

`NEXT_PRODUCT_PHASE = INTEGRATE_FROZEN_CORE_AND_CLOSE_LEGACY_CALLABLE_ANSWER`

Port the frozen proof in front of cache and persistence, reject non-v2 parking answers on the same callable, then add the proof tests, App Check, cache binding, controlled deploy, and smoke. Do not start that phase from the dirty `main` worktree or from the SI-LAUNCH worktree.
