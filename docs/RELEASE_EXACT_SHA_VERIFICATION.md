# Exact-SHA release verification

`.github/workflows/release-exact-sha-verify.yml` verifies **one immutable release commit that is not on `main`**,
for example a narrow release built on the live production baseline. It exists because neither existing route can:

- a pull request into `main` runs CI on the merge with current `main`, not on the release commit;
- PR Gate's `workflow_dispatch` fails closed by design (`workflow_dispatch has no pull-request diff`).

It does not replace or change PR Gate, the provenance guard, the ruleset, or any required check.

## What a run proves

A run dispatched **from `main`** with `release_sha`, `release_branch` and `baseline_sha`:

1. Uses only the reviewed workflow and `scripts/ci/release-exact-sha.mjs` from `main` (every job refuses another ref).
2. Requires full SHAs, a `release/...` branch whose current head on this repository is `release_sha`, and a baseline
   listed in `scripts/ci/release-production-baselines.json` that is an ancestor of the release.
3. Records the release and baseline tree SHAs and the exact changed-file inventory (name-status and its sha256).
4. Rejects any change to Functions, rules, indexes, Firebase project/deploy config other than `hosting.headers`,
   runtime source, CI policy or workflows, release preflight, fixtures, S7, claim/handoff/lifecycle client files,
   Street Intelligence client logic, dependency lockfiles, package-manager config (`.npmrc` etc.), test/build/
   TypeScript verification config, the production build guard, secret-scan config, and native Firebase credentials.
   `package.json` must be identical to the baseline except for script changes listed in
   `REVIEWED_PACKAGE_SCRIPT_CHANGES` with exact before/after digests (today only `test:street-intel`); any npm
   lifecycle script (`preinstall`, `install`, `postinstall`, `prepare`, `prepack`, any `pre*`/`post*`) must not change.
5. Provenance, in two independent parts, both required:
   - **Historical verifier.** The baseline's own `provenance-change-guard.mjs`, `provenance-evidence.mjs` and trust
     anchor are recognized only by the git blob ids and sha256 digests reviewed in
     `release-production-baselines.json` (`verifier.historical`). They are run from exactly those bytes against
     `baseline...release` and must report `PROVENANCE_GUARD: PASS`.
   - **Current policy.** `main`'s verifier files must match the reviewed `verifier.currentPolicy` digests, and the
     current guard's `decisionForPath` must classify every changed path `clear`. A newer, stricter policy therefore
     still applies to an old baseline. Any other verifier version on either side fails closed until the record is
     re-reviewed. There is no founder-evidence route here: exact-SHA releases may not touch critical paths.
6. Checks out the release (and, separately, the baseline) detached, confirms commit, tree and clean tracked state,
   and runs every PR Gate suite in PR Gate's order: npm ci, general PR unit suite, `tsc`, production build, PostHog
   release assertion, Playwright smoke/accessibility, Functions install (npm 10), Sharp checks, Functions index load,
   Functions integration and isolated fence tests, Firestore rules, analytics-consent emulator, Storage rules.
7. Scans `baseline..release` with pinned gitleaks 8.30.1 (checksum-verified) and `main`'s `.gitleaks.toml`.
8. Runs CodeQL (same pinned action and `security-and-quality` suite as `codeql.yml`) on the release with upload
   disabled, and fails on any result located in a file the release changes.
9. Re-checks at the end that the branch still points at `release_sha`.

Disposition is fail-closed. **PASS** requires all of: authorization and provenance records with `ok: true`; complete
evidence for **both** release and baseline (commit and tree matching the authorized identities, an outcomes file
with exactly the 17 expected checks, each `0` or `1`, no duplicates or unknown names); a real unit-test report
(`numTotalTests > 0`, no failures) when unit tests pass; every release check `0`; gitleaks and both CodeQL languages
exit `0`; and a successful branch-head re-check. Anything missing, malformed or unknown is **FAIL**. A failure the
baseline shares under the same CI is **BLOCKED** (founder disposition required), never PASS. A missing baseline
can never produce PASS.

Evidence: artifact `exact-sha-evidence-<release_sha>` (`evidence.json`, `evidence.md`, 90-day retention) with the
workflow ref and SHA, run id, release and baseline commits and trees, changed-file hash, per-check outcomes for
release and baseline, failing tests, and the CI build manifest hash.

## What it does not prove

- It is **not** the required `gate` or `private provenance required` check and does not satisfy the ruleset.
- It does not run the private 26C suite. It accepts only releases with no provenance-critical path.
- The CI build uses CI configuration. A deployable artifact must be rebuilt from the same tree with the approved
  production configuration and its manifest bound separately.
- Tests execute release code, as in any CI. The run uses a read-only token, no secrets and demo emulator projects.
- It does not deploy, and must not be used to deploy an artifact built from any other commit or configuration.

## Running it (after this workflow is reviewed and on `main`)

```powershell
gh workflow run release-exact-sha-verify.yml --ref main -f release_sha=<40-hex> -f release_branch=release/<name> -f baseline_sha=<40-hex>
```

The release branch must already be pushed to this repository. Evidence is valid only for the recorded release SHA,
tree, baseline and workflow SHA.

## Governance

- The workflow, `scripts/ci/release-exact-sha.mjs`, its test and `release-production-baselines.json` are
  provenance-critical (the workflow is listed in the guard's `POLICY_FILES`; the rest are under `scripts/ci/`).
  Adding or changing any of them needs founder-signed FOUNDER-EXECUTED evidence for the exact PR head.
- When `main`'s verifier changes (as PR #383 did), `verifier.currentPolicy` no longer matches and every exact-SHA run
  fails closed until a reviewed change updates the record. That update is itself provenance-critical.
