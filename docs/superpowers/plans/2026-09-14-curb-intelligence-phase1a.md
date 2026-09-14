# Curb Intelligence Phase 1A Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a tested, additive official-curb identity foundation and fail-closed DOT street-cleaning classifier without changing production behavior.

**Architecture:** New pure CommonJS modules under `functions/curbIntelligence/` model versioned CSCL identity, project NYC coordinates into local meters, classify roadway/side confidence from uncertainty intervals, recognize only reviewed cleaning sign identities before reusing the existing schedule parser, and define privacy-safe shadow comparison records. Nothing is imported by `functions/index.js` in Phase 1A.

**Tech Stack:** Node.js 22, CommonJS with JSDoc contracts, Vitest, existing `functions/nycOpenDataNormalizer.js` parser.

**Spec:** Owner-approved “PARQUEEN — CURB INTELLIGENCE PHASE 1A” task brief dated 2026-09-14.

## Global Constraints

- No user-facing or production behavior change.
- Do not modify Android, Capacitor, native geolocation, or notification files owned by PR #156/#157.
- Do not write Firestore documents, telemetry, schedulers, live API calls, or production caches.
- Preserve source-native values and source-version evidence; fail closed on malformed or ambiguous evidence.
- Block Face IDs remain strings and are never converted through `Number()`.
- Use only small public NYC fixtures; no private/raw user location.
- No dependencies or downloaded bulk data.

---

### Task 1: Versioned CSCL identity and adapter

**Files:**
- Create: `functions/curbIntelligence/curbIdentity.js`
- Test: `functions/curbIntelligence/curbIdentity.test.js`

**Interfaces:**
- Produces `normalizeBlockFaceId(value)`, `normalizeCsclSourceVersion(value)`, and `createOfficialCurbIdentity(input)`.
- Rejects numeric IDs so already-lost leading zeros cannot silently become canonical identity.
- Preserves map asset `3mf9-qshr`, resource `inkn-q76z`, Global IDs, Physical IDs as evidence, B5SC, roadway/level data, native names, side, and resolution evidence.

- [x] Write identity tests covering leading-zero preservation, numeric rejection, zero/malformed rejection, source version requirements, multiple segment/physical references, and missing selected face.
- [x] Run the focused test and verify RED because the module is absent.
- [x] Implement the smallest fail-closed identity adapter.
- [x] Run the focused test and verify GREEN.

### Task 2: Metric geometry foundation

**Files:**
- Create: `functions/curbIntelligence/geometry.js`
- Test: `functions/curbIntelligence/geometry.test.js`

**Interfaces:**
- Produces `projectPointToMultiLineString(point, coordinates)` and `rankRoadwayCandidates(point, candidates)`.
- Accepts GeoJSON coordinate order `[longitude, latitude]` explicitly.
- Returns distance, projection, local tangent, signed offset, CSCL side, component/segment indices, and endpoint proximity in meters.

- [x] Write literal tests for horizontal, vertical, diagonal, curved/multisegment, opposing sides, endpoint proximity, malformed coordinates, and competing parallel roadways.
- [x] Run the focused test and verify RED.
- [x] Implement a NYC-scale local tangent-plane projection and point-to-segment accumulation with no external calls.
- [x] Run the focused test and verify GREEN.

### Task 3: Accuracy-aware confidence classifier

**Files:**
- Create: `functions/curbIntelligence/confidence.js`
- Test: `functions/curbIntelligence/confidence.test.js`

**Interfaces:**
- Produces `classifyCurbResolution(evidence)` returning `{state, reasons, uncertaintyMeters, roadwayIntervals, sideInterval}`.
- Uses combined reported accuracy plus explicit model error; no single global accuracy cutoff.

- [x] Write interval-based tests for supported separation, ±25 m on a 12 m street, overlapping parallel roads, missing BFI, endpoint ambiguity, level ambiguity, implausible geometry, and invalid evidence.
- [x] Run the focused test and verify RED.
- [x] Implement UNKNOWN-first validation, roadway interval competition, then side/endpoint CAUTION evaluation.
- [x] Run the focused test and verify GREEN.

### Task 4: Safe cleaning identity and schedule classifier

**Files:**
- Create: `functions/curbIntelligence/cleaningClassifier.js`
- Test: `functions/curbIntelligence/cleaningClassifier.test.js`

**Interfaces:**
- Produces `classifyStreetCleaningSign(row, streetContext)` and exports the reviewed exception-table version for provenance.
- Reuses `parseNYCOpenDataSign` only after current-row and reviewed broom-identity gates pass.

- [x] Write RED tests for the standard broom identity; exact PS-188B, PS-162BA, and PS-165BA reviewed typo rows; Current enforcement; PS-15G/39G/38G/175G rejection; PS-7A/6A rider rejection; SP-798C placeholder rejection; exact code/text pairing; supported days/times; and nonzero schedule duration.
- [x] Run the focused test and verify RED.
- [x] Implement exact normalized marker recognition plus a small versioned code-and-marker exception table, then validate the existing parser output and retain source evidence.
- [x] Run the focused test and verify GREEN.

### Task 5: Public NYC fixture matrix

**Files:**
- Create: `functions/curbIntelligence/fixtures/nycCurbFixtures.js`
- Create: `functions/curbIntelligence/nycFixtures.test.js`

**Interfaces:**
- Produces small immutable public fixtures for the nine owner-specified ParkNYC/DOT/CSCL cases with an explicit `exercises` list.

- [x] Write the fixture-contract test first for source attribution, expected cleaning duration or fail-closed outcome, identity/ambiguity evidence, and absence of private fixture data.
- [x] Run and verify RED.
- [x] Add only the public evidence required by the tests, including Chatham 30m, Gold 60m, St James 90m, East 170 30m, Bay mismatch/caution, William no-invented-cleaning, and Queens multi-zone ambiguity.
- [x] Run and verify GREEN.

### Task 6: Privacy-safe shadow and ingest boundaries

**Files:**
- Create: `functions/curbIntelligence/contracts.js`
- Test: `functions/curbIntelligence/contracts.test.js`

**Interfaces:**
- Produces source-adapter boundary documentation/constants and `createShadowComparison(input)`.
- Allows only reviewed mismatch categories and non-sensitive derived fields; rejects raw coordinate and fine-geometry keys recursively.

- [x] Write RED tests for every approved mismatch category, source-version representation, exact-agreement records, and rejection of latitude/longitude/coordinate/geometry fields.
- [x] Run and verify RED.
- [x] Implement the minimal allowlisted contract and recursive privacy guard.
- [x] Run and verify GREEN.

### Task 7: Regression and repository gates

**Files:**
- Modify only earlier Phase 1A files if a genuine gate failure requires it.

- [x] Run all new Phase 1A tests.
- [x] Run existing NYC Open Data parser tests.
- [x] Run PR #154 presentation/confidence tests.
- [x] Run the root client suite.
- [x] Run `npx.cmd tsc --noEmit`.
- [x] Run `npx.cmd vite build` with upload disabled by the established repository mechanism.
- [x] Run `git diff --check`.
- [x] Verify no Android/native overlap, source maps, secrets, private-key markers, bulk NYC data, or private GPS fixtures.
- [ ] Run current-tree and exact-range Gitleaks checks without exposing values.
- [ ] Review the final diff against the phase boundary and commit locally only if every gate passes.
