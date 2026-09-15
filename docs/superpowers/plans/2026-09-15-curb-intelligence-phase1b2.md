# Curb Intelligence Phase 1B.2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Attach official NYC DOT cleaning rules and ParkNYC meter rules to a Phase 1B.1 resolved curb in a deterministic, fail-closed, shadow-only model.

**Architecture:** Add pure CommonJS normalizers, bounded source-adapter contracts, independent cleaning and meter association engines, and a privacy-safe combined shadow mapper under `functions/curbIntelligence/`. DOT association requires an explicit official face-context boundary because `nfid-uabd` has no Block Face ID or documented coordinate CRS; ParkNYC association uses official block-face geometry and metric ranking. Neither path is imported by `functions/index.js` or writes data.

**Tech Stack:** Node.js 22, CommonJS/JSDoc contracts, Vitest, existing Phase 1A metric geometry and cleaning classifier, existing Phase 1B.1 curb resolver/fingerprint/privacy contracts.

**Spec:** Owner-approved “PARQUEEN — CURB INTELLIGENCE PHASE 1B.2” task brief dated 2026-09-15.

## Global Constraints

- Shadow-only: no production imports, calls, persistence, telemetry, scheduling, UI, Firestore, Android/native, Hosting, or deployment changes.
- Preserve independent curb, cleaning, and meter confidence; a rule state may be capped by but never exceed curb identity state.
- DOT `nfid-uabd` association never falls back to street-name plus side, fuzzy names, broad long-street queries, or undocumented sign-coordinate projection.
- ParkNYC zone IDs are payment identifiers, never curb identity; geometry, side, borough, official names/bounds, competitors, completeness, and vehicle branch all remain explicit.
- Deterministic tests use only small public official fixtures. No bulk datasets, archives, raw/private GPS, user data, or new dependencies.
- Unsupported source values, incomplete retrieval, mixed source versions, ambiguous geometry/bounds/sides, and partially parsed essential terms fail closed.

---

### Task 1: Source identity and bounded adapter contracts

**Files:**
- Create: `functions/curbIntelligence/ruleSourceAdapters.js`
- Test: `functions/curbIntelligence/ruleSourceAdapters.test.js`

**Interfaces:**
- Produces `createSocrataSourceVersion(metadata, expectedResourceId)`, `createMemoryRuleCandidateStore(records, options)`, and `readConsistentCandidateSnapshot(source, query)`.
- Candidate results have `{ candidates, completeness: { state: 'COMPLETE'|'INCOMPLETE', reason }, sourceVersion }`.

- [ ] Write failing tests for exact resource identity, observed update metadata, before/after source-version equality, invalid metadata, candidate truncation, coverage gaps, and explicit completeness.
- [ ] Run `npm.cmd test -- functions/curbIntelligence/ruleSourceAdapters.test.js` and verify failure because the module is absent.
- [ ] Implement only dependency-injected adapters; no network client or production import.
- [ ] Rerun the focused test and verify green.

### Task 2: DOT current-sign normalization and official face-context boundary

**Files:**
- Create: `functions/curbIntelligence/dotSignNormalizer.js`
- Create: `functions/curbIntelligence/dotFaceAssociation.js`
- Test: `functions/curbIntelligence/dotSignNormalizer.test.js`
- Test: `functions/curbIntelligence/dotFaceAssociation.test.js`

**Interfaces:**
- `normalizeDotSignRow(row, sourceVersion)` retains the 25 verified source-native fields and rejects non-Current rows, missing source identity, malformed sign identity, and malformed placement evidence.
- `createFaceAssociationContext(input)` accepts a resolved curb state plus explicit official borough/name/bounds/side relationships and optional verified projected sign evidence.
- `associateDotCandidates(context, candidateSnapshot)` returns candidates with `associationState`, `reasonCodes`, and `applicability: 'WHOLE_FACE'|'PARTIAL_FACE'|'UNKNOWN'`.

- [ ] Write failing normalizer tests using exact small current DOT fixture rows, plus historical/malformed/version failures.
- [ ] Verify RED, implement minimal normalization, and verify GREEN.
- [ ] Write failing association tests proving exact official bounds may match in either endpoint order, SND-declared aliases may match, side must match, missing context is UNKNOWN, name+side alone is never sufficient, incomplete snapshots cannot be SUPPORTED, and source-version mismatch fails closed.
- [ ] Add partial-face tests using arrow, distance, sign-order/location, and stacked-sign evidence; partial/unknown extent cannot become whole-face SUPPORTED.
- [ ] Verify RED, implement the explicit context boundary, and verify GREEN.

### Task 3: Cleaning rule association and canonical conflict semantics

**Files:**
- Create: `functions/curbIntelligence/cleaningRuleAssociation.js`
- Test: `functions/curbIntelligence/cleaningRuleAssociation.test.js`

**Interfaces:**
- Produces `associateCleaningRules({ curbIdentity, faceContext, candidateSnapshot })`.
- Reuses `classifyStreetCleaningSign` and `createCleaningFingerprint`; normalized rules carry type/source/version/state/reasons/applicability/schedules/provenance/raw evidence.

- [ ] Write failing tests for 30/60/90/180-minute schedules, EXCEPT SUNDAY, discrete days, legitimate multiple schedules, input-order invariance, duplicate corroboration, true same-domain conflicts, reviewed typo provenance, timed non-broom rejection, standalone rider rejection, template rejection, and no cleaning inferred from meter evidence.
- [ ] Verify RED, implement minimal grouping by canonical fingerprint, and verify GREEN.
- [ ] Add state-cap tests for SUPPORTED/CAUTION/UNKNOWN curb identity and ensure partial-face or incomplete-source evidence cannot exceed CAUTION/UNKNOWN.

### Task 4: ParkNYC source normalization and typed meter terms

**Files:**
- Create: `functions/curbIntelligence/parkNycNormalizer.js`
- Test: `functions/curbIntelligence/parkNycNormalizer.test.js`

**Interfaces:**
- Produces `normalizeParkNycRow(row, sourceVersion)`.
- Exact vehicle enums: `All Vehicles`, `Commercial Only`, `Dual (Commercial / All Vehicles)`, `Charter Bus Only`.
- Branch parser returns day ranges/windows in NYC civil time, maximum minutes, supported tiered or fixed rates, raw source strings, and parse completeness.

- [ ] Write failing tests from live rows for All Vehicles, Commercial Only, Dual independent passenger/commercial branches, Charter exclusion, and unknown-class failure.
- [ ] Write failing tests for `N/A`, `2 Hours`, `3 Hours`, supported `Monday-Saturday 7:30 AM-7 PM`, tiered `$5.00 1st Hour / $8.25 2nd Hour`, fixed `$1.50 per Hour`, unsupported clauses, slash-delimited caps, multiple windows, and overnight windows.
- [ ] Verify RED, implement exact parsers for tested formats only, preserve raw strings, and verify GREEN.
- [ ] Prove unsupported essential schedules/classes are UNKNOWN, incomplete noncritical rates remain CAUTION with raw evidence, and no parser emits “free parking” or cleaning semantics.

### Task 5: Metric ParkNYC face association and multiple-zone handling

**Files:**
- Create: `functions/curbIntelligence/parkNycAssociation.js`
- Test: `functions/curbIntelligence/parkNycAssociation.test.js`

**Interfaces:**
- Produces `associateParkNycRules({ curbIdentity, resolvedPoint, officialNames, officialBounds, candidateSnapshot })`.
- Uses existing metric projection/ranking against ParkNYC MultiLineString geometry, while enforcing borough, side, official/SND name, bounds, completeness, and competitor checks.

- [ ] Write failing tests for a unique matching passenger row, wrong borough/side/bounds, zone-only rejection, geometry ambiguity, incomplete candidate coverage, off-network geometry, semantically identical corroborating rows, multiple distinct zones, and commercial-only passenger exclusion.
- [ ] Verify RED, implement the narrow association algorithm, and verify GREEN.
- [ ] Prove multiple zones are preserved in deterministic order; explainable one-to-many is CAUTION and unresolved competing faces/zones is UNKNOWN.

### Task 6: Independent per-rule confidence and combined shadow result

**Files:**
- Create: `functions/curbIntelligence/ruleConfidence.js`
- Create: `functions/curbIntelligence/curbRuleShadow.js`
- Test: `functions/curbIntelligence/ruleConfidence.test.js`
- Test: `functions/curbIntelligence/curbRuleShadow.test.js`
- Modify: `functions/curbIntelligence/contracts.js`
- Modify: `functions/curbIntelligence/contracts.test.js`

**Interfaces:**
- `capAssociationState(ruleState, curbState)` uses `UNKNOWN < CAUTION < SUPPORTED`.
- `createInternalCurbRuleResult` retains identity, per-domain rules/confidence/reasons/source versions/diagnostics without cross-domain confidence influence.
- `toPersistableCurbRuleComparison` allowlists only non-reversible derived counts/states/fingerprints/categories/source versions.

- [ ] Write failing state-cap and cross-domain independence tests.
- [ ] Verify RED, implement the state lattice, and verify GREEN.
- [ ] Write failing combined-result/privacy tests that reject raw lat/lng, address, geohash, geometry, BFI, sign coordinates, ParkNYC geometry, zone IDs, order numbers, and other reversible exact location identifiers recursively.
- [ ] Verify RED, extend the existing allowlist narrowly, and verify GREEN.

### Task 7: Nine current public NYC regression fixtures

**Files:**
- Create: `functions/curbIntelligence/fixtures/nycRuleFixtures.js`
- Create: `functions/curbIntelligence/nycRuleFixtures.test.js`

**Interfaces:**
- Exports exactly nine deeply frozen public fixtures with observed source identities, minimal current official row evidence, expected curb/cleaning/meter states, and any difference from Phase 0 research.

- [ ] Write the failing fixture-contract test for the nine approved locations only, source attribution, fixture-size limits, no private/user GPS, and expected independent domain states.
- [ ] Verify RED, add minimal official DOT/ParkNYC excerpts, and verify GREEN.
- [ ] Add end-to-end fixture tests proving Chatham identity caps both domains, Gold and Prince support safe associations, St James/East 170/Pierrepont remain capped CAUTION, Bay retains cautious/unknown face difficulty, William creates no passenger obligation or cleaning, and Queens 33 preserves multiple zones while remaining UNKNOWN.

### Task 8: Scope, regression, security, and artifact gates

**Files:**
- Modify only Phase 1B.2 files if a genuine test defect requires a RED/GREEN correction.

- [ ] Run Phase 1A tests, Phase 1B.1 tests, all Phase 1B.2 tests, and the entire `functions/curbIntelligence` suite.
- [ ] Run NYC Open Data parser and Street Intelligence confidence/presentation regressions, then `npm.cmd test`.
- [ ] Run `npx.cmd tsc --noEmit` and the established no-upload `npx.cmd vite build`.
- [ ] Run `git diff --check`, current-tree Gitleaks, and exact-range Gitleaks.
- [ ] Verify zero source maps, `sourceMappingURL`, tokens/private keys, committed archives/bulk datasets, private/user GPS, precise-location fields in persistable records, and unexpected generated files.
- [ ] Verify `functions/index.js`, UI, Firestore, Rules, Android/native, dependencies, production wiring, telemetry, and existing Phase 1A/1B.1 behavior remain untouched.

### Task 9: Exact-diff review and one local commit

**Files:**
- Review: all Phase 1B.2 files relative to base `9009875148084507c12609cdb75f6c20ff7a599b`.

- [ ] Review every changed line against the approved scope and verified official schemas.
- [ ] Rerun the freshest focused tests after any review correction.
- [ ] Create exactly one local commit with the completed Phase 1B.2 implementation.
- [ ] Confirm the branch is clean and ahead of base by one commit.
- [ ] Do not push, open a PR, merge, deploy, or mutate Firebase/production.
