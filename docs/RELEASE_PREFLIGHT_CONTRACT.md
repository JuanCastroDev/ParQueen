# ParQueen Release Preflight Contract

This contract answers one question: is this exact ParQueen commit safe and sufficiently validated to be considered release-ready?

Preflight does not deploy Firebase, Hosting, or Functions. It does not modify production data, read production logs, sign Android releases, upload Sentry source maps, run Capacitor `cap:sync` or `cap:copy`, or change Git history.

Decisions are `BLOCK`, `WARN`, `MANUAL`, `EXCLUDE`, or `NOT SUITABLE YET`. A gate is either runnable today, blocked on a small implementation fix, or remote GitHub evidence. Production-facing commands in section 25 never run during preflight.

Command safety classes:

| Class | Meaning |
|---|---|
| `READ-ONLY` | No workspace writes and no production access. Default for automated preflight. |
| `LOCAL MUTATION ONLY` | May write local artifacts (`node_modules`, `dist`, emulator processes). Allowed only when this contract names the command. |
| `EXTERNAL READ` | Reads an external service for release evidence. Allowed only for the checks named here. |
| `PRODUCTION MUTATION` | Changes production. Never allowed. |

These classes are not mutually exclusive. A command that has more than one effect uses a composite classification, such as `LOCAL MUTATION + EXTERNAL READ`. `PRODUCTION MUTATION` is never combined into an allowed preflight command.

This document is written for Windows PowerShell. It does not assume GitHub branch protection. It does not encode test-count expectations from older docs.

## 1. Release identity

A release candidate must have a clean worktree, a known intended commit SHA, and release evidence tied to that same SHA.

`BLOCK` if the worktree is dirty, `HEAD` is not the intended SHA, or remote CI evidence belongs to a different SHA.

| Command | Class |
|---|---|
| `git status --porcelain` | `READ-ONLY` |
| `git rev-parse HEAD` | `READ-ONLY` |

Status today: ready.

## 2. Dependency installs

Use reproducible installs only.

| Command | Class | Decision |
|---|---|---|
| `npm ci` | `LOCAL MUTATION + EXTERNAL READ` | `BLOCK` if it fails |
| `npm ci --prefix functions` | `LOCAL MUTATION + EXTERNAL READ` | `BLOCK` if it fails |

Each command replaces local `node_modules` and may read or download package data from the npm registry. That does not change the release decision: failure is `BLOCK`. `npm audit` stays `EXTERNAL READ` only.

Do not use `npm install` or `npm run install:functions`.

Status today: ready.

## 3. TypeScript

Command: `npx tsc --noEmit`

Class: `READ-ONLY`. Decision: `BLOCK`.

`tsconfig.json` sets `noEmit: true`. PR Gate already runs this check.

Status today: ready.

## 4. Root unit tests

Command: `npm test`

Class: `READ-ONLY` (it reads `dist/` when that directory exists; it does not build it).

Decision: `NOT SUITABLE YET` as a zero-failure local release gate.

`utils/appCheckBundleAssertion.test.ts` depends on `dist/`. If `dist/` is absent, the relevant assertions skip and a green run does not prove them. If `dist/` contains stale output, the tests inspect stale artifacts. Raw `npm test` therefore does not prove the current source tree produced a valid bundle.

`functions/curbIntelligence/privateResolverComposition.test.js` includes timing behavior where implementation deadlines can exceed Vitest’s default timeout. The previously observed sample-zero failure is timing- and environment-sensitive. It is not a stable intentional baseline. Do not encode an expected test count.

Before `npm test` can become `BLOCK`:

1. Define a deterministic `dist/` lifecycle, or build the current source in the isolated release-build environment immediately before the tests.
2. Make resolver test timeouts consistent with implementation deadlines.

`npm run test:street-intel` overlaps the root Vitest suite. It is an optional targeted check when Street Intelligence code changes, not an independent release gate.

`npm run test:curb-topology` is an optional targeted check. It requires Python and is not in CI. Do not make it universally blocking until the Python runtime expectation is formalized.

## 5. Firestore rules

Command: `npm run test:rules`

Class: `LOCAL MUTATION ONLY` (local emulator processes). Decision: `BLOCK`.

Requires the Firebase CLI and Java. The command passes `--project demo-parkqueen-rules-test`, which matches `firestore.rules.test.ts`. Do not substitute the project in `.firebaserc`.

Status today: ready when the Firebase CLI and Java are present. CI installs those tools; they are not npm dependencies of this repository.

## 6. Storage rules

Current command: `npm run test:storage:rules`

Decision: `EXCLUDE` until patched.

`storage.rules.test.ts` uses `demo-parkqueen-storage-test`. The npm emulator command does not pass `--project`. `.firebaserc` names production project `parkqueen-46475363-ccf36`. An automated run must not rely on that default.

Required change: add `--project demo-parkqueen-storage-test`. After that change is implemented and one run is validated, Storage rules become `BLOCK`. Class remains `LOCAL MUTATION ONLY`.

## 7. Functions integration tests

Current command: `npm run test:functions`

Decision on Windows: `EXCLUDE` until patched.

The script embeds `sh -c`, so it is not native PowerShell. It does not pass a demo project. Integration tests take their project id from `GCLOUD_PROJECT` through `requireEmulatorProjectId()`, which accepts any non-empty value, including the production project id.

Required wrapper, preferably Node rather than shell syntax:

```text
firebase emulators:exec
  --only functions,firestore,auth,storage
  --project demo-parkqueen-functions-test
  --
  npx vitest run --config vite.functions.config.ts
```

The child process must also receive `GCLOUD_PROJECT=demo-parkqueen-functions-test`. The wrapper must not require bash or `sh`, must not deploy, must not read production data, must use only local emulators, and must not print environment values.

Class: `LOCAL MUTATION ONLY`. After implementation and one validated green execution, the decision becomes `BLOCK`.

## 8. Production build

Command: `npm run build`

Decision: `BLOCK` only inside an isolated environment. Class: `LOCAL MUTATION ONLY` (`dist/`).

The build fails closed unless `VITE_MAPBOX_TOKEN` is non-blank. The guard runs for Vite `command === 'build'`.

Vite can load variables from the process environment and from `.env*` files. Source-map upload activates when `SENTRY_AUTH_TOKEN`, `SENTRY_ORG`, and `SENTRY_PROJECT` all resolve.

`PARQUEEN_VITE_ENV_DIR` stops Vite from loading the normal `.env*` files. It does not remove Sentry variables already inherited through `process.env`. Do not clear the parent shell to compensate.

The future release-build wrapper must do both of the following, and must not print secret values:

1. Set `PARQUEEN_CONFIG_CONTRACT_TEST=1` and point `PARQUEEN_VITE_ENV_DIR` at an isolated directory that contains only the intended Vite build variables, including `VITE_MAPBOX_TOKEN`.
2. Spawn the build in a sanitized child-process environment where `SENTRY_AUTH_TOKEN`, `SENTRY_ORG`, and `SENTRY_PROJECT` are explicitly absent. Sanitize only that child process.

`BLOCK` if the isolated production build fails. Do not query Sentry, upload artifacts, or read production issues. Sentry production health is outside mandatory local preflight. Do not run `cap:sync` or `cap:copy`.

## 9. Dependency audits

Run at release time. Do not reuse a cached zero. Both production audits were previously observed at zero findings; that observation is not a substitute for the release-time run. Do not run `npm audit fix` or `npm audit fix --force`.

| Command | Class | Decision |
|---|---|---|
| `npm audit --omit=dev` | `EXTERNAL READ` | `BLOCK` on any non-zero production vulnerability result |
| `npm audit --omit=dev --prefix functions` | `EXTERNAL READ` | `BLOCK` on any non-zero production vulnerability result |
| Full `npm audit` (includes devDependencies) | `EXTERNAL READ` | `WARN` |

The full audit is `WARN` because of a known dev-only chain: `@capacitor/cli` → `xcode` → `uuid@7.0.3`. That chain is marked dev-only in the root lockfile. It must not weaken the production audit.

## 10. Secret scanning

Authoritative gate: GitHub workflow `Secret scan` (job `gitleaks`).

Decision: `BLOCK` remotely. Class of consulting the check: `EXTERNAL READ`.

The workflow runs on every push and pull request, fetches full Git history, and uses `.gitleaks.toml` and `.gitleaksignore`. Thirteen ignored fingerprints are recorded. Success means zero new findings after those allowlists and ignores. Evidence must be for the intended SHA.

Local Gitleaks is optional. Do not require a local binary until the repository defines a pinned reproducible local invocation. Never run Gitleaks without redaction.

## 11. Static analysis not used as release blockers

| Tool | Decision | Reason |
|---|---|---|
| Knip (`npm run check:knip`) | `WARN` | Config and script exist. No committed finding baseline. Not run in CI. Class: `READ-ONLY`. |
| ast-grep (`npm run ast:grep`) | `MANUAL` | CLI and script exist. No rule pack. A bare invocation is not a deterministic gate. Use only for targeted investigation. |
| OSV-Scanner | `EXCLUDE` | No repository configuration or workflow. A global install is not a release capability. |
| Semgrep | `EXCLUDE` | No repository configuration or workflow. |
| Trivy | `EXCLUDE` | No repository configuration or workflow. |

## 12. Android, Maestro, and iOS

Android: a Gradle project, `gradlew.bat`, and Vitest contract tests exist. Release signing is external. Automated preflight must not run `assembleRelease`, `bundleRelease`, `signReleaseBundle`, or any other signing task, and must not require release signing credentials. Decision for release signing: `EXCLUDE`. A debug or compile-only Android gate may be added later, after SDK and JDK requirements are formalized.

Maestro: flow YAML exists under `.maestro/`. There is no runner script and no CI workflow. Decision: `MANUAL`. Existence of a flow is not evidence that it ran.

iOS: an Xcode project exists. Windows preflight must not require an iOS compile. Decision: `EXCLUDE` on Windows. Native iOS build or test belongs to a future macOS stage.

## 13. GitHub CI evidence

Bind every cited run to the intended SHA.

| Check | Decision | Rule |
|---|---|---|
| `Secret scan` | `BLOCK` | Runs on every push and pull request. Evidence must be for the exact intended release SHA. |
| `PR Gate` / job `gate` | `BLOCK` when a run exists for the SHA | Not path-filtered. Runs on pull requests to `main` and on `workflow_dispatch`. Does not run on an ordinary push to `main`. Internal steps may skip suites based on changed paths. `workflow_dispatch` runs the client, Functions, Firestore, and Storage categories. |

Pull requests are normally merged with merge commits, so the release SHA on `main` may not be the pull-request head SHA. If PR Gate did not run against the exact intended release SHA, a `workflow_dispatch` run is required:

1. Dispatch PR Gate from a Git ref that currently resolves to the intended release SHA.
2. Retrieve the resulting workflow run.
3. Verify that the GitHub-reported `headSha` exactly equals the intended release SHA.
4. `BLOCK` if the SHA differs.
5. If the ref moved before or during dispatch, discard that evidence and rerun from a ref that resolves to the intended SHA.

Secret scan evidence must be tied to that same intended SHA. Branch-protection settings are not known from this repository.

Do not treat these path-filtered workflows as universal release requirements. They are supplemental evidence only:

- Unit Tests
- Firestore Security Rules
- Avatar Pipeline

Branch-protection settings are not visible in this repository. Do not claim a check is enforced by GitHub unless that setting is verified separately.

## 14. Firebase project isolation

Automated preflight must never rely on the default project in `.firebaserc` (`parkqueen-46475363-ccf36`).

Every emulator-based release gate must name a demo project:

| Suite | Project id |
|---|---|
| Firestore rules | `demo-parkqueen-rules-test` |
| Storage rules | `demo-parkqueen-storage-test` |
| Functions integration | `demo-parkqueen-functions-test` |

Never run during preflight (`PRODUCTION MUTATION` or production `EXTERNAL READ`):

- `firebase deploy`
- `firebase deploy --only functions`
- Firebase Hosting deploy
- Firestore or Storage rules deploy
- index deploy
- `firebase functions:log`
- production Hosting HTTP checks
- production Console or API reads

## 15. Current release decision table

| Capability | Decision | Status Today |
|---|---|---|
| Git clean + intended SHA | `BLOCK` | Ready |
| `npm ci` root | `BLOCK` | Ready |
| `npm ci` Functions | `BLOCK` | Ready |
| TypeScript | `BLOCK` | Ready |
| `npm test` | `NOT SUITABLE YET` | Needs deterministic dist + timeout policy |
| Firestore rules | `BLOCK` | Ready |
| Storage rules | `BLOCK` after fix | Needs explicit demo project |
| Functions integration | `BLOCK` after fix | Needs Windows wrapper + demo project |
| Production build | `BLOCK` after fix | Needs isolated Vite env |
| Root production audit | `BLOCK` | Ready |
| Functions production audit | `BLOCK` | Ready |
| Full dev audit | `WARN` | Known dev-only chain |
| Gitleaks | `BLOCK` via CI | Ready remotely |
| Knip | `WARN` | Ready |
| ast-grep | `MANUAL` | No rules |
| OSV-Scanner | `EXCLUDE` | Not integrated |
| Semgrep | `EXCLUDE` | Not integrated |
| Trivy | `EXCLUDE` | Not integrated |
| Maestro | `MANUAL` | No runner/CI |
| Android release signing | `EXCLUDE` | Outside generic preflight |
| iOS compile | `EXCLUDE` on Windows | Requires macOS |
| PR Gate | `BLOCK` remotely | PR or `workflow_dispatch` required |
| Secret scan | `BLOCK` remotely | Runs every push/PR |

## 16. Outcomes

`PASS`: every mandatory local and remote `BLOCK` gate passed.

`PASS WITH WARNINGS`: every `BLOCK` gate passed, and one or more `WARN` checks produced findings.

`BLOCKED`: any mandatory `BLOCK` gate failed, required release evidence is missing, or a required gate cannot be executed safely.

`MANUAL` items do not block unless a later policy promotes them. `EXCLUDE` items are not executed. `NOT SUITABLE YET` items are not mandatory `BLOCK` gates.

## 17. Implementation order

Do not treat this list as authorization to change the repository. Implement later, in this order:

1. Git identity guard.
2. Root and Functions `npm ci`.
3. TypeScript.
4. Production audits.
5. Firestore rules.
6. Storage explicit demo project.
7. Windows Functions emulator wrapper.
8. Isolated production-build wrapper.
9. Deterministic `npm test` policy (dist lifecycle and timeouts).
10. Knip warning pass.
11. GitHub PR Gate verification for the SHA.
12. GitHub Secret scan verification for the SHA.
13. Final `PASS`, `PASS WITH WARNINGS`, or `BLOCKED` summary.

## 18. Non-goals

This contract does not require OSV-Scanner, Semgrep, Trivy, ast-grep rule enforcement, Maestro automation, Android release signing, iOS compilation from Windows, production Firebase checks, or Sentry production health queries.

Promote any of those only after a reproducible, repository-backed capability exists.
