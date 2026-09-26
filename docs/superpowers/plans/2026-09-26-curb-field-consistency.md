# Curb Field Consistency Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve canonical V2 fail-closed behavior while making field failures queryable and locking deterministic curb identity under synthetic GPS jitter.

**Architecture:** Keep the existing server-owned canonical resolver and exact public-curb-key cache unchanged. Emit canonical telemetry through Firebase's structured logger, add only low-cardinality privacy-safe accuracy/failure/candidate buckets, and expose safe resolver diagnostics solely to the telemetry boundary. Add deterministic synthetic geometry tests; do not change confidence thresholds, source hierarchy, retries, or public response schemas.

**Tech Stack:** Node.js 22 Firebase Functions, Vitest, TypeScript/JavaScript, Firebase structured logging.

**Spec:** `C:\Users\jayca\.codex\attachments\9d4a0141-0e44-43fb-aa68-87f55e3f5203\Pasted text.txt`

## Global Constraints

- Do not add Street Intelligence features or lower confidence thresholds.
- Never guess across an intersection; ambiguity must remain chooser/fail-soft.
- Do not expose coordinates, UID, blockface IDs, source row IDs, tokens, raw rows, or raw errors.
- Do not change DOT/SweepNYC hierarchy, cache identity, resolver scale, retry count, rule categories, or public persistence schema.
- Production validation is passive only; do not create a synthetic parking save.
- Deploy only `createSegmentFromSweepNYC` if the verified change is merged.

## Review Focus

- Missing/invalid GPS accuracy must produce only an allowlisted `unknown` bucket and never leak the original value.
- Complete-but-empty CSCL evidence must distinguish missing coverage from truncated/incomplete coverage without changing the public fail-soft response.
- Perpendicular roads within the GPS uncertainty interval must remain ambiguous rather than selecting the nearest centerline.
- Mid-block jitter along one curb must retain one public curb identity and side.
- Logger failures must remain fail-soft and must not affect callable responses.

---

### Task 1: Privacy-safe structured canonical telemetry

**Files:**
- Modify: `functions/curbIntelligence/curbTelemetry.js`
- Modify: `functions/curbIntelligence/curbTelemetry.test.js`
- Modify: `functions/curbIntelligence/canonicalCurbOrchestrator.js`
- Modify: `functions/curbIntelligence/canonicalCurbOrchestrator.test.js`
- Modify: `functions/index.js`

**Interfaces:**
- Consumes: canonical resolver `{ state, reasons, candidateCount? }` results and V2 request location metadata.
- Produces: Firebase structured `jsonPayload.event` records with `accuracyBucket`, `failureDetail`, and existing candidate/sample/latency buckets.

- [ ] **Step 1: Write failing tests** proving default telemetry uses the Firebase structured logger, exact accuracy boundaries are bucketed, unknown failure details are dropped, forbidden private values remain absent, and unsupported orchestration emits safe detail/count metadata.
- [ ] **Step 2: Run focused tests and verify RED** for missing structured default logging and missing bucket/detail fields.
- [ ] **Step 3: Implement the minimal telemetry change** using the existing structured-log adapter and remove the explicit `console` sink from canonical V2 composition.
- [ ] **Step 4: Run focused tests and verify GREEN.**

### Task 2: Safe resolver diagnostics and deterministic geometry matrix

**Files:**
- Modify: `functions/curbIntelligence/canonicalCurbResolver.js`
- Modify: `functions/curbIntelligence/canonicalCurbResolver.test.js`
- Modify: `functions/curbIntelligence/canonicalCurbPersistence.test.js`

**Interfaces:**
- Consumes: synthetic CSCL/planimetric fixtures only.
- Produces: unchanged public resolver states plus non-public `candidateCount` diagnostics for telemetry.

- [ ] **Step 1: Write failing tests** for complete-empty versus incomplete CSCL evidence and safe candidate counts.
- [ ] **Step 2: Run focused tests and verify RED** with the current `candidate_coverage_incomplete` conflation.
- [ ] **Step 3: Implement the minimal diagnostic classification change** so complete-empty evidence reports `canonical_candidate_missing`, incomplete evidence remains `candidate_coverage_incomplete`, and public orchestration still returns `candidate_incomplete`.
- [ ] **Step 4: Add the synthetic matrix** for mid-block, perpendicular intersection, corner, ±3 m/±5 m/±10 m jitter, poor accuracy, exact-cache acceptance, perpendicular-cache rejection, stable side, ambiguity, and high confidence.
- [ ] **Step 5: Run focused tests and verify GREEN.**

### Task 3: Verification, review, and controlled release

**Files:**
- Modify: none unless verification identifies a directly related defect.

**Interfaces:**
- Consumes: Tasks 1–2.
- Produces: verified PR, merge SHA, and callable-only deployment if all gates pass.

- [ ] **Step 1: Run Street Intelligence tests, Rules tests, full repository tests, TypeScript check, production build, secret scan, and diff checks.**
- [ ] **Step 2: Confirm only documented baseline failures remain and no sensitive telemetry fields appear.**
- [ ] **Step 3: Commit, push, open a new PR, and inspect all CI results.**
- [ ] **Step 4: Merge normally only if no new failures appear.**
- [ ] **Step 5: Deploy only `createSegmentFromSweepNYC`, verify the new revision/config/traffic/log structure passively, and leave Hosting unchanged.**

