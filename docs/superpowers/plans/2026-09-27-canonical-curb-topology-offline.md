# Canonical Curb Topology Offline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build deterministic, private offline tooling that validates official CSCL/Pavement Edge snapshots and produces a versioned BFI-centered topology artifact without changing production runtime behavior.

**Architecture:** A CommonJS offline library under `scripts/curb-topology/` accepts normalized export records plus a strict source manifest, constructs fail-closed topology records, deterministically shards them, and emits reproducibility, quality, and performance reports. A small Python extraction adapter reads the official CSCL file geodatabase into newline-delimited public evidence; explicit relationship inputs are preferred, while exact centerline-endpoint-to-official-Node reconstruction is separately classified and measured when the public release omits relationships.

**Tech Stack:** Node.js 22-compatible CommonJS, Vitest, Node standard library crypto/fs/perf APIs, optional Python 3 + pyogrio for official file-geodatabase extraction.

**Spec:** `docs/CANONICAL_CURB_RECOVERY_DESIGN.md`

## Global Constraints

- Offline evidence tooling only; no production callable, resolver, Firebase, Hosting, feature-gate, or recovery behavior changes.
- Use official NYC CSCL Pub and Pavement Edge sources only as topology evidence.
- Never commit full city snapshots or generated citywide artifacts.
- Fail closed on missing provenance, schema drift, unknown encodings, ambiguity, conflicts, or incomplete topology.
- Keep BFIs, source IDs, raw geometry, and generated topology artifacts server/private and out of client imports and `dist/`.
- Do not run the 5,000-point benchmark or Function 3C corpus.
- Do not run a Sentry-enabled client build; upload credentials remain absent if a build becomes necessary.

## Review Focus

- Numerically valid-looking BFIs supplied through floats, exponential notation, padding, or whitespace must be rejected.
- Multipart/reversed centerlines and endpoint coordinate precision must not silently reverse official CSCL side or create false node matches.
- Multiple valid non-equivalent endpoint streets must yield `topology_ambiguous`, not a stable but arbitrary name.
- Mixed release IDs or duplicate source roles must invalidate the snapshot before any artifact bytes are written.
- Server-only artifacts must remain unreachable from client import graphs even if a future developer adds a convenient shared-module import.

---

### Task 1: Manifest, canonical serialization, and strict BFI contract

**Files:**
- Create: `scripts/curb-topology/lib/canonicalJson.js`
- Create: `scripts/curb-topology/lib/bfi.js`
- Create: `scripts/curb-topology/lib/manifest.js`
- Create: `scripts/curb-topology/manifest.test.js`
- Create: `scripts/curb-topology/bfi.test.js`

**Interfaces:**
- Produces: `canonicalJson(value)`, `sha256(bytes)`, `normalizeBfi(value)`, `validateSnapshotManifest(manifest, inventory)`, and `manifestIdentity(manifest)`.

- [ ] Write failing tests for deterministic key ordering, timestamp separation, source-role uniqueness, missing fields/digests/releases, schema allowlists, row-count bounds, digest mismatch, and every malformed BFI class.
- [ ] Run the focused tests and confirm failures are caused by missing modules.
- [ ] Implement the minimal pure utilities and strict validation errors.
- [ ] Run focused tests to green and commit.

### Task 2: Official source extraction and pure normalizers

**Files:**
- Create: `scripts/curb-topology/extract_cscl.py`
- Create: `scripts/curb-topology/lib/geometry.js`
- Create: `scripts/curb-topology/lib/normalizers.js`
- Create: `scripts/curb-topology/normalizers.test.js`
- Create: `scripts/curb-topology/fixtures/public-official-records.json`

**Interfaces:**
- Consumes: Task 1 BFI and canonical serialization utilities.
- Produces: `normalizeCsclCenterline`, `normalizeCsclNode`, `normalizeStreetName`, `normalizePavementEdge`, and NDJSON extraction with release/provenance metadata.

- [ ] Write failing fixture-backed tests for real CSCL field names, multipart geometry, official side fields, B5SC/B7SC, levels/status/roadbed evidence, and observed Pavement Edge `CONFLATED` encodings (`0`, `1`, `"0"`, `"1"`) while rejecting every unknown representation.
- [ ] Run focused tests and verify RED.
- [ ] Implement minimal normalizers and an extraction adapter that never infers unsupported fields.
- [ ] Run focused tests to green and commit.

### Task 3: BFI-centered topology construction and endpoint context

**Files:**
- Create: `scripts/curb-topology/lib/topology.js`
- Create: `scripts/curb-topology/topology.test.js`

**Interfaces:**
- Consumes: normalized centerlines, nodes, street names, and optional explicit segment-node/name relations.
- Produces: `buildTopology(records, options)` returning records plus completeness/ambiguity/fallback counters.

- [ ] Write failing tests for ordinary, grouped, reversed, sparse, intersection, divided-road, missing-endpoint, ambiguous-endpoint, conflicting-side, level-conflict, and roadbed-conflict cases.
- [ ] Run focused tests and verify RED.
- [ ] Implement exact BFI grouping, official-side consistency, explicit-relation preference, exact endpoint-to-Node fallback classification, and deterministic on/from/to derivation with no alphabetical tiebreaker.
- [ ] Run focused tests to green and commit.

### Task 4: Pavement Edge reconciliation and B5SC/B7SC evidence

**Files:**
- Create: `scripts/curb-topology/lib/reconcile.js`
- Create: `scripts/curb-topology/reconcile.test.js`

**Interfaces:**
- Consumes: normalized Pavement Edge rows and Task 3 topology records.
- Produces: `reconcilePavementBfi(edge, topologyIndex)` and bridge-coverage statistics.

- [ ] Write failing tests for non-conflated rejection, missing/invalid BFI, one material group/side/context success, conflicting side/group rejection, and direct segment-local B7SC coverage.
- [ ] Run focused tests and verify RED.
- [ ] Implement exact evidence reconciliation only; no spatial guessing or runtime query behavior.
- [ ] Run focused tests to green and commit.

### Task 5: Versioned artifacts, deterministic sharding, and lookup measurements

**Files:**
- Create: `scripts/curb-topology/lib/artifact.js`
- Create: `scripts/curb-topology/artifact.test.js`

**Interfaces:**
- Consumes: topology records and manifest identity.
- Produces: schema-v1 index/shards, per-shard digests, prefix/hash-prefix comparison metrics, exact lazy lookup, and byte-identical outputs.

- [ ] Write failing tests for schema fields, stable ordering, deterministic filenames/bytes/digests, bounded shards, two strategy comparison, missing/digest-invalid shard rejection, and cold/warm/lazy lookup timing hooks.
- [ ] Run focused tests and verify RED.
- [ ] Implement the smallest deterministic writer/reader and choose the measured strategy.
- [ ] Run the builder twice over fixtures, compare every byte, run focused tests to green, and commit.

### Task 6: Privacy/import boundaries and Geosupport corpus schema

**Files:**
- Create: `scripts/curb-topology/privacy.test.js`
- Create: `scripts/curb-topology/lib/geosupportCorpus.js`
- Create: `scripts/curb-topology/geosupportCorpus.test.js`

**Interfaces:**
- Produces: static dependency assertions and `normalizeVerificationCorpusRecord(record)` with fingerprints only.

- [ ] Write failing tests proving offline modules/artifacts are absent from Vite public/client/runtime callable dependency graphs and corpus records reject raw requests, coordinates, BFIs, or responses.
- [ ] Run focused tests and verify RED.
- [ ] Implement static graph checks and deterministic fingerprint-only corpus records.
- [ ] Run focused tests to green and commit.

### Task 7: Citywide build, quality report, and delivery evidence

**Files:**
- Create: `scripts/curb-topology/build.js`
- Create: `scripts/curb-topology/lib/report.js`
- Create: `scripts/curb-topology/report.test.js`
- Create: `data/curb-topology/manifest.template.json`
- Create: `data/curb-topology/README.md`
- Modify: `.gitignore`
- Modify: `package.json`

**Interfaces:**
- Consumes: Tasks 1–6.
- Produces: `npm run test:curb-topology`, `npm run build:curb-topology`, machine-readable/Markdown quality reports, performance metrics, and package-delivery comparison.

- [ ] Write failing report/CLI tests for all required counts, borough/status breakdowns, fallback and B7SC coverage, generation/memory/size/shard/latency metrics, and fail-before-write behavior.
- [ ] Run focused tests and verify RED.
- [ ] Implement streaming CLI/report orchestration and ignore snapshot/artifact output directories.
- [ ] Pin the acquired official release metadata, run the citywide build twice, and stop if any mandated STOP condition is observed.
- [ ] Record bundled-lazy versus private-object-storage evidence without creating buckets/IAM, run focused tests to green, and commit.

### Task 8: Documentation, regression verification, and PR preparation

**Files:**
- Create: `docs/CANONICAL_CURB_TOPOLOGY_ARTIFACT.md`
- Create: `docs/reports/CANONICAL_CURB_TOPOLOGY_QUALITY.md`
- Create: `docs/reports/canonical-curb-topology-quality.json`

**Interfaces:**
- Consumes: measured Task 7 outputs.
- Produces: acquisition/refresh runbook, evidence findings, transition criteria, and review-ready PR.

- [ ] Document official sources, manifest, topology/fallback policy, schema, sharding, provenance, privacy, reproducibility, measurements, B5SC/B7SC result, delivery recommendation, gaps, and 2A.35C entry criteria.
- [ ] Run all offline tests, relevant canonical-curb tests, Street Intelligence focused suite, static privacy checks, and Gitleaks; report known baseline failures without changing them.
- [ ] Prove `functions/index.js` and current runtime dependency graph contain no offline import and review the full diff for runtime/config mutations.
- [ ] Run a fresh whole-branch review, address Critical/Important findings with RED→GREEN tests, then commit, push, and open the unmerged review PR.

