# Private Geosupport Resolver Implementation Plan

> Execute this plan test-first in the dedicated Phase 2A.8 worktree. Make one final local commit only; do not push, deploy, or wire production consumers.

**Goal:** Build and locally verify a minimal private Flask/Gunicorn service that resolves reviewed Function 3C blockfaces through the pinned Geosupport 26C native runtime and fails closed for every non-authoritative result.

**Architecture:** A strict HTTP contract feeds a serialized resolver service. A release-specific ctypes adapter owns mutable native work areas and GRC-first parsing. Gunicorn provides one-worker/one-thread execution and timeout-based process recovery.

**Tech stack:** Python 3.12, Flask, Gunicorn, pytest, ctypes, Docker.

---

## Task 1: Define injected contract tests

**Files:**
- Create: `services/curb-intelligence-resolver/tests/test_http_contract.py`
- Create: `services/curb-intelligence-resolver/tests/test_service_policy.py`
- Create: `services/curb-intelligence-resolver/tests/test_logging_privacy.py`
- Create: `services/curb-intelligence-resolver/tests/conftest.py`

- [ ] Write failing tests for exact-field schema validation, canonical borough mapping, ASCII and byte-length limits, compass validation, and native-call suppression on invalid input.
- [ ] Write failing tests for GRC `00`, every non-`00` result, stale Blockface ID suppression, native exceptions, malformed native success data, health, and stable response shapes.
- [ ] Write failing tests proving calls are serialized and sensitive values never appear in captured logs.
- [ ] Run the focused tests and confirm they fail because the implementation is absent.

## Task 2: Implement the smallest HTTP and policy layer

**Files:**
- Create: `services/curb-intelligence-resolver/resolver_service/__init__.py`
- Create: `services/curb-intelligence-resolver/resolver_service/contracts.py`
- Create: `services/curb-intelligence-resolver/resolver_service/service.py`
- Create: `services/curb-intelligence-resolver/resolver_service/app.py`
- Create: `services/curb-intelligence-resolver/resolver_service/operational_logging.py`

- [ ] Implement exact request validation and internal borough-code mapping.
- [ ] Implement serialized one-attempt resolution, GRC-first acceptance, ten-digit string identity validation, and fail-closed response normalization.
- [ ] Implement sanitized operational logging and health reporting.
- [ ] Run the focused tests and make them pass without broadening the contract.

## Task 3: Define and implement the pinned native adapter

**Files:**
- Create: `services/curb-intelligence-resolver/tests/test_native_adapter.py`
- Create: `services/curb-intelligence-resolver/resolver_service/native_adapter.py`

- [ ] Write failing adapter tests for mutable work-area construction, reviewed offsets, Function 3C preservation, GRC-first parsing, and non-`00` identity suppression.
- [ ] Implement the direct ctypes integration against the pinned release-specific work-area contract.
- [ ] Run adapter and service tests and make them pass.

## Task 4: Package the one-worker service

**Files:**
- Create: `services/curb-intelligence-resolver/resolver_service/wsgi.py`
- Create: `services/curb-intelligence-resolver/gunicorn.conf.py`
- Create: `services/curb-intelligence-resolver/requirements.txt`
- Create: `services/curb-intelligence-resolver/requirements-dev.txt`
- Create: `services/curb-intelligence-resolver/Dockerfile`
- Create: `services/curb-intelligence-resolver/.dockerignore`
- Create: `services/curb-intelligence-resolver/README.md`

- [ ] Pin the approved Geosupport base image digest and all Python dependencies.
- [ ] Configure one sync worker, one thread, a 10-second worker timeout, disabled access logs, and worker-local native initialization.
- [ ] Document local build/run/test steps, strict contract, failure semantics, future timeout guidance, and release-review obligations.
- [ ] Run all unit tests.

## Task 5: Validate the pinned local container

**Files:**
- Create: `services/curb-intelligence-resolver/tests/fixtures.json`
- Create: `services/curb-intelligence-resolver/tests/run_container_fixtures.py`

- [ ] Build the image locally from the digest-pinned Dockerfile.
- [ ] Start it bound to localhost only and confirm the compact health response.
- [ ] Run all six real fixtures through HTTP: five exact Phase 1 Blockface ID matches and St James safe rejection.
- [ ] Confirm no request, identity, address, native message, or raw work-area data appears in container logs.
- [ ] Stop and remove only the Phase 2A.8 test container.

## Task 6: Review, scan, and commit once

- [ ] Review the complete diff for scope, correctness, privacy, and release-specific assumptions.
- [ ] Run the full resolver test suite and clean container verification from current source.
- [ ] Run repository secret scanning for the exact `origin/main..HEAD` range and current worktree.
- [ ] Confirm no unrelated tracked file changed and no deployment, IAM, Firebase, client, push, or PR action occurred.
- [ ] Create one final local commit and verify the worktree is clean.
