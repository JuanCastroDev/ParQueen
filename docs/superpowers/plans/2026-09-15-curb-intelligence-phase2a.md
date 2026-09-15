# Curb Intelligence Phase 2A Implementation Plan

**Goal:** Add a production-unwired, contract-first shadow execution engine that composes the merged Phase 1 curb resolver and rule associators, compares structured legacy cleaning evidence, and emits only low-cardinality aggregate-safe telemetry.

**Architecture:** Pure CommonJS modules under `functions/curbIntelligence/` orchestrate transient location evidence through an injected CSCL candidate store, injected DOT/ParkNYC snapshot providers, and an injected official DOT order-to-face relationship provider. Rich runtime evidence is structurally separate from persistable telemetry. Missing relationship evidence fails only the cleaning domain closed; meter execution remains independent. Nothing is imported by `functions/index.js`.

**Tech stack:** Node.js 22, CommonJS, Vitest, existing Phase 1A/1B.1/1B.2 modules, platform `AbortController`; no new dependencies.

## Safety boundary

- No production hook, persistence, scheduler, task queue, Pub/Sub, UI, Android/native, Firestore, or deployment change.
- Raw location and official roadway geometry remain in process memory only.
- The fixture relationship provider is test-only and never a default dependency.
- General runtime without an official relationship provider is intentionally cleaning-incomplete and returns UNKNOWN.
- Shadow failure never changes or throws into a primary result path.

## Task 1: Ephemeral curb-resolution evidence

**Files:**
- Create `functions/curbIntelligence/runtimeCurbResolution.js`
- Create `functions/curbIntelligence/runtimeCurbResolution.test.js`

- [x] RED: prove public resolution and non-persistable runtime evidence are separate.
- [x] RED: prove selected/competing CSCL geometry, width, side, completeness, uncertainty, and version are captured without changing `resolveOfficialCurb`.
- [x] GREEN: wrap the injected candidate store, delegate to the existing resolver, and derive the minimal evidence from the selected record/group.
- [x] Prove malformed/incomplete evidence fails closed and public output does not contain geometry.

## Task 2: CSCL-side cross-check for ParkNYC

**Files:**
- Modify `functions/curbIntelligence/parkNycAssociation.js`
- Modify `functions/curbIntelligence/parkNycAssociation.test.js`

- [x] RED: LEFT/positive and RIGHT/negative stable geometry may remain eligible.
- [x] RED: contradiction, meaningful centerline crossing, and near-centerline uncertainty cannot become SUPPORTED.
- [x] RED: reversed centerline digitization preserves CSCL side semantics and traffic direction is irrelevant.
- [x] GREEN: classify representative signed offsets using resolved `csclSide`, explicit separation tolerance, and reviewed reason codes.

## Task 3: Structured legacy cleaning adapter and neutral comparison

**Files:**
- Create `functions/curbIntelligence/legacyCleaningAdapter.js`
- Create `functions/curbIntelligence/legacyCleaningAdapter.test.js`
- Create `functions/curbIntelligence/cleaningComparison.js`
- Create `functions/curbIntelligence/cleaningComparison.test.js`

- [x] RED: adapt only actual `{segment, activeRules}` structure and presentation evidence guarantees.
- [x] RED: distinguish usable, none, malformed, and unavailable; never consume UI strings or Safe Until.
- [x] GREEN: canonicalize structured schedules with the existing fingerprint producer and map legacy state conservatively.
- [x] RED/GREEN: implement order-invariant neutral comparison categories, with no meter influence.

## Task 4: Strict aggregate telemetry and sinks

**Files:**
- Create `functions/curbIntelligence/shadowTelemetry.js`
- Create `functions/curbIntelligence/shadowTelemetry.test.js`
- Strengthen `functions/curbIntelligence/curbRuleShadow.js` and its tests only where shared validation requires it.

- [x] RED: reject all forbidden keys recursively through objects and arrays, including runtime evidence and identity fields.
- [x] RED: reject arbitrary categories/reasons/versions and unbounded counts.
- [x] GREEN: project only reviewed state/category/boolean/bucket/version dimensions.
- [x] RED/GREEN: Noop sink and deterministic aggregate memory sink; no event history or user/session linkage.

## Task 5: Execution policy and standalone runner

**Files:**
- Create `functions/curbIntelligence/shadowExecution.js`
- Create `functions/curbIntelligence/shadowExecution.test.js`

- [x] RED: initial curb resolution precedes domain retrieval.
- [x] RED: DOT and ParkNYC retrieval can run concurrently under shared overall and per-source abort deadlines.
- [x] RED: absent/unavailable/malformed/unmapped relationship produces cleaning UNKNOWN while meter independently completes.
- [x] RED: source timeouts, malformed responses, incomplete coverage, and unexpected exceptions collapse to allowlisted diagnostics without raw messages/stacks.
- [x] GREEN: implement dependency-injected orchestration with zero retries, candidate caps, safe diagnostics, runtime/persistable separation, and sink isolation.
- [x] Prove sink failure and any shadow failure return a safe observation rather than throwing.

## Task 6: Nine-fixture end-to-end replay

**Files:**
- Create `functions/curbIntelligence/nycShadowExecution.test.js`
- Add test-only helpers under `functions/curbIntelligence/fixtures/` only if needed.

- [x] RED/GREEN: execute all nine public fixture cases through the runner with deterministic stores and the explicitly test-only reviewed relationship provider.
- [x] Preserve Phase 1B.2 curb/cleaning/meter states, including Gold/Prince full support, Chatham caps, William no passenger obligation, and Queens fail-closed competing evidence.
- [x] Prove the general runner has no fixture relationship default.

## Task 7: Scope and regression gates

- [x] Run exact Phase 1A, Phase 1B.1, Phase 1B.2, Phase 2A, and complete Curb Intelligence suites.
- [x] Run NYC parser, Street Intelligence confidence/presentation, relevant Functions, and full root suites.
- [x] Run `npx.cmd tsc --noEmit`, established no-upload Vite build, and `git diff --check`.
- [x] Run current-tree and exact-range Gitleaks.
- [x] Verify artifact/privacy hygiene, no maps/archives/bulk data/private GPS/secrets, and no forbidden telemetry fields.
- [x] Verify `functions/index.js`, Firestore files, UI, Android/native, dependencies, and Parsona are untouched.

## Task 8: Exact-diff review and one local commit

- [x] Review every changed line against the approved contract-first boundary.
- [x] Rerun affected tests after any review correction.
- [x] Create one local commit only after all gates pass.
- [x] Confirm clean branch one commit ahead of base.
- [x] Do not push, open a PR, merge, deploy, or mutate production.
