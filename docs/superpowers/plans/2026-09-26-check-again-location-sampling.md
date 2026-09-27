# Check Again Location Sampling Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent “Check again” from calling the canonical curb backend until the existing location-quality requirements are satisfied.

**Architecture:** Keep the existing high-accuracy burst shared by initial save and retry. Make the collector stop as soon as an aggregate satisfies the existing 3-sample, 50m-accuracy, and 12m-consistency policy, then enforce that policy at a testable client request boundary so an incomplete burst becomes the existing `location_quality` response without a callable invocation.

**Tech Stack:** React, TypeScript, Firebase callable client, Vitest.

**Spec:** Phase 2A.34 Check Again Location Re-sampling task supplied in this Codex task.

## Global Constraints

- Do not change curb identity, CSCL search radius, confidence thresholds, resolver logic, or the legacy 80m cache.
- One user action may perform one bounded location collection and at most one callable POST.
- Preserve `canonical_candidate_missing` as fail-closed when authoritative candidates remain absent.
- Deploy only default application Hosting; do not deploy Functions, resolver, marketing Hosting, or configuration.

## Review Focus

- One- and two-sample timeout results must not invoke the callable.
- Three mutually consistent, sufficiently accurate samples must stop collection early and invoke exactly once.
- A burst with poor aggregate accuracy must remain local `location_quality`, even with three samples.
- A burst whose aggregate consistency exceeds 12m must remain local `location_quality`.
- Repeated taps while the first retry is collecting must not start a second collection or POST.

---

### Task 1: Canonical-ready location burst

**Files:**
- Modify: `utils/locationBurst.ts`
- Modify: `utils/locationBurst.test.ts`

**Interfaces:**
- Consumes: raw `LocationSample` values and existing `LOCATION_BURST_POLICY` thresholds.
- Produces: `isCanonicalLocationReady(location)` and an early-valid `collectLocationBurst()` result.

- [x] **Step 1: Write failing tests** proving a valid three-sample aggregate stops early, while one/two samples, poor accuracy, and inconsistent aggregates are not canonical-ready.
- [x] **Step 2: Run `npx vitest run utils/locationBurst.test.ts` and verify RED** because the readiness function and early stop do not exist.
- [x] **Step 3: Implement the readiness predicate and call it after each accepted sample**, preserving the 1.8-second bound and five-sample cap.
- [x] **Step 4: Run the focused test and verify GREEN.**
- [x] **Step 5: Commit the collector behavior.**

### Task 2: One-call client boundary and retry state

**Files:**
- Modify: `utils/canonicalCurbClient.ts`
- Modify: `utils/canonicalCurbClient.test.ts`
- Modify: `views/StreetParkingView.tsx`
- Modify: `views/street-parking/StreetParkingView.streetIntel.test.tsx`
- Modify: `i18n/en.ts`
- Modify: `i18n/es.ts`

**Interfaces:**
- Consumes: `AggregatedLocation`, `isCanonicalLocationReady`, a location collector, and one callable invocation function.
- Produces: `resolveCanonicalCurbWithLocation(...)`, returning `location_quality` locally or a strictly parsed canonical response.

- [x] **Step 1: Write failing tests** proving one/two/poor/inconsistent aggregates make zero backend calls, a valid aggregate makes exactly one call, and `canonical_candidate_missing` remains `candidate_incomplete`.
- [x] **Step 2: Add the retry contract test** proving initial save and Check again use the same request boundary and the existing in-flight guard disables a repeated tap.
- [x] **Step 3: Run focused tests and verify RED** for the missing request boundary.
- [x] **Step 4: Implement the minimal request boundary and use it from `requestCanonicalCurb`** without changing request or response schemas.
- [x] **Step 5: Update the existing temporary retry copy** to “Rechecking your curb…” and its Spanish equivalent; retain the disabled state.
- [x] **Step 6: Run focused tests and verify GREEN.**
- [x] **Step 7: Commit the request/UI behavior.**

### Task 3: Verification and client-only release

**Files:**
- Modify: none unless verification finds a directly related defect.

**Interfaces:**
- Consumes: Tasks 1–2.
- Produces: a reviewed PR, merge SHA, and Hosting-only release.

- [ ] **Step 1: Run Street Intelligence, Rules, full repository tests, TypeScript, production build, Gitleaks, and diff checks.**
- [ ] **Step 2: Confirm only documented baseline failures remain and server-side files/configuration are unchanged.**
- [ ] **Step 3: Push, open a PR, and inspect required CI.**
- [ ] **Step 4: Merge normally only when no new failure appears.**
- [ ] **Step 5: Deploy default app Hosting only, then verify Hosting and Mapbox passively.**
