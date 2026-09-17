# ParQueen Release Operations Runbook

Assessment date: 2026-07-24  
Status: draft — based on repository and Firebase configuration inspection; steps require operator validation before first use

---

## Overview

This runbook covers the steps to deploy a web release of ParQueen. It does not cover native iOS/Android packaging; those require a separate runbook once a native architecture is selected.

**Key principle:** All changes to production must be separately approved before execution. This runbook describes steps, not authorization. Do not execute any step without a go/no-go decision from the designated approver.

---

## Pre-deployment checklist

Run through the full QA Release Matrix (`docs/QA_RELEASE_MATRIX.md`) Gates 1–9 before proceeding. Every REQUIRED row must be PASS. Record gate sign-offs in that document.

In addition, confirm:

- [ ] BLK-01 resolved: `cdn.voiceagent.ai` script removed from `index.html`
- [ ] BLK-02 resolved: Firestore Rules on audit branch approved for deployment
- [ ] BLK-03 resolved: `deleteAccount` callable covers all data collections
- [ ] BLK-04 resolved: CSP headers defined in `firebase.json`
- [ ] BLK-05 resolved: Phone and email removed from public user document
- [ ] Storage Rules committed to `storage.rules` and approved
- [ ] All secrets confirmed rotated/valid (TM-19)
- [ ] Firebase budget alert set

---

## Environment setup

### Required tools

- Node.js 20+ (production Functions runtime) or 24+ (used in audit)
- npm 11+
- Firebase CLI: `npm install -g firebase-tools`
- Firebase project access: `firebase login` with authorized account
- Git with access to `origin/main`

### Firebase project

- Project ID: `parkqueen-46475363-ccf36`
- Hosting URL: `https://parkqueen-46475363-ccf36.web.app`
- Region: `us-central1` (Functions)
- Production branch: `main`

---

## Release provenance

Every production deploy must leave a **GitHub Release evidence card** that binds **git commit SHA ↔ Firebase live resource IDs**. Chat, agent memory, and screenshots are not the audit trail.

### Required fields (every card)

| Field | Requirement |
|---|---|
| `git_sha` | Full 40-character commit SHA on `main` that was authorized and deployed |
| `tag` | Immutable Git tag / GitHub Release name (see tag rules) |
| `utc_time` | Deploy time in ISO-8601 UTC (`…Z`). See multi-target timestamps |
| `firebase_project` | `parkqueen-46475363-ccf36` (until a second project exists) |
| `targets` | Exact subset deployed this action: `Hosting`, `Functions`, `Firestore Rules`, `Storage Rules`, `indexes` |
| `initiator` | Person or agent who ran the deploy |
| `approver` | Who gave go/no-go (normally Juan) |
| `ci` | Link(s) to green CI runs on **this** `git_sha` for required gates |
| `review` | PR numbers merged into the SHA, or explicit “already on main” note |
| Live IDs | Hosting version ID and/or Ruleset IDs and/or Function `name→revision` (and hash if available) and/or indexes note — **only for targets in scope**; others `n/a` |
| `rollback` | Prior Hosting version / prior ruleset ID / prior Functions SHA / indexes note |
| `verified_by` / `verified_at` / `method` | Who confirmed live IDs match this card, when (UTC), how |

A card with SHA/targets but **empty live IDs is incomplete** and must not be used to claim VERIFIED.

### Tag rules (immutable)

- **Product / multi-target cut:** `vX.Y.Z`
- **Narrow single-target (or partial) cut:** `deploy/YYYYMMDD-<targets>-<shortsha>`  
  Example: `deploy/20260912-firestore-rules-5d11695`
- Tags are **immutable**:
  - **Do not move** a production tag to a different commit.
  - **Do not reuse** a tag name for a later deploy.
  - **Do not delete** a production tag to “fix” history; publish a new tag/Release instead.
- The tag must point at the exact authorized `git_sha` before or when the Release is published.
- Prefer creating/publishing the GitHub Release **after** deploy succeeds, when live IDs are known (a draft Release pre-deploy is OK; publish only when the card is complete).

### Multi-target timestamps

- **One deploy action** = one evidence card.
- If multiple Firebase targets are deployed in **one approved action** (same SHA, same approver, sequential `firebase deploy --only …` in one session):
  - Set `utc_time` to the **session start** (first deploy command) in UTC.
  - Also record **per-target live timestamps** under Live IDs (Hosting `releaseTime`, Rules `updateTime`, Functions `updateTime` for changed functions).
- If targets are deployed in **separate** approvals or sessions, use **separate** tags/Releases — do not overload one card.
- Never claim undeployed targets were updated by this card.

### Evidence card template (GitHub Release body)

```text
# ParQueen production deploy

- git_sha: <40-char SHA>
- tag: <vX.Y.Z | deploy/…>
- utc_time: <ISO-8601 Z>   # session start if multi-target same action
- firebase_project: parkqueen-46475363-ccf36
- targets: [Hosting | Functions | Firestore Rules | Storage Rules | indexes]
- initiator: <person or agent>
- approver: <Juan | …>
- ci: <Actions run URL(s) on this SHA>
- review: <PR #s or “on main” note>

## Live resource IDs (fill after deploy)
- hosting_version: <…/versions/… or n/a>
- hosting_release_time: <Z or n/a>
- firestore_ruleset: <…/rulesets/… or n/a>
- firestore_rules_update_time: <Z or n/a>
- storage_ruleset: <…/rulesets/… or n/a>
- storage_rules_update_time: <Z or n/a>
- functions: <name→revision→firebase-functions-hash for changed set, or n/a / unchanged>
- indexes: <“composites match firestore.indexes.json @ SHA” + count, or n/a>

## Rollback reference
- hosting: prior version <id> / `firebase hosting:rollback`
- firestore_rules: prior ruleset <id> or tree at <prior_sha>
- storage_rules: prior ruleset <id> or tree at <prior_sha>
- functions: redeploy from <prior_sha>
- indexes: <rarely rolled back — note explicitly>

## Verification
- verified_by: <Release agent / person>
- verified_at: <Z>
- method: live API IDs match this card (+ rules content compare if Rules in targets)
```

### Canonical evidence location

| Layer | Role |
|---|---|
| **GitHub Release** (canonical) | Evidence card + immutable `tag → git_sha` |
| **Firebase live IDs** | What is actually running; re-read via ADC/REST |
| **This runbook** | Process + template only — not the history log |

Do not treat chat, agent memory, or console screenshots as the system of record.

### Operator sequence

1. Approver go/no-go on **SHA + exact target list**.
2. Confirm CI green on that SHA; paste run URLs into the card.
3. Deploy **only** the approved narrow `firebase deploy --only …` targets.
4. Same session: capture live IDs (Hosting live version, Rules releases/rulesets, Functions revisions for changed names, indexes if targeted).
5. Publish GitHub Release with the completed card.
6. Release classifies each in-scope target VERIFIED or UNKNOWN per rules below.

Optional (Hosting only): label the Hosting version with `git_sha` and `release_tag` via Hosting API. Helpful, not required if the Release card records `hosting_version`.

### VERIFIED / UNKNOWN / INFERRED (Release classification)

**Timing correlation alone never makes a SHA claim VERIFIED.**

For claimed SHA `S` and target `T`:

| Label | Meaning |
|---|---|
| **VERIFIED** | Live Firebase API resource for `T` matches the evidence card for `S` (see per-target rules). |
| **UNKNOWN** | No complete card, missing live IDs, live ID ≠ card, or only headers / Last-Modified / merge-time proximity. |
| **INFERRED** | Narrative footnote only (e.g. timing). **Must not** upgrade a SHA claim to VERIFIED. |

**Per-target VERIFIED rules**

| Target | VERIFIED iff |
|---|---|
| Hosting | Live `live` channel version ID **equals** `hosting_version` on the card for `S` |
| Firestore Rules | Live `cloud.firestore` ruleset ID **equals** card, **or** live rules content is comment-stripped identical to `firestore.rules` at `S` |
| Storage Rules | Same pattern for the Storage rules release/ruleset |
| Functions | Each in-scope function’s live `revision` (and hash when recorded) **equals** the card for `S` |
| indexes | Live composite index set structurally matches `firestore.indexes.json` at `S`; field overrides called out separately if not measured |

**READY** (narrow cut): all **intended** targets on the card are VERIFIED. Other targets may remain UNKNOWN without blocking a rules-only READY.

### Explicit non-goals

- No custom provenance service, spreadsheet, or Firestore “releases” collection required.
- No backfill of historical Hosting/Functions → git SHA unless a specific incident needs it.
- Incomplete cards must not be published as production truth.

## Deployment steps

### Step 1: Prepare the release branch

```bash
git checkout main
git pull origin main
# Verify baseline commit
git log --oneline -1  # expected: b761795 or a descendant
```

Cherry-pick or merge only approved commits from `audit/app-store-readiness-2026`:

```bash
# Example — only after separate code review and approval of each commit
git cherry-pick <firestore-rules-fix-commit>
git cherry-pick <dependency-fix-commit>
# Do NOT cherry-pick in bulk; review each commit independently
```

### Step 2: Run full gate suite

```bash
npm ci                     # must succeed without flags
npx tsc --noEmit           # must pass
npm test                   # must pass all tests
npm run build              # must produce dist/; fails closed without VITE_MAPBOX_TOKEN
npm run test:rules         # must pass all 70 tests
```

Do not proceed if any gate fails.

### Step 3: Verify no secrets in bundle

```bash
# After npm run build:
grep -r 'AIzaSy' dist/ | grep -v 'apiKey'      # Should only match the public Firebase apiKey
grep -r 'sk-\|SG\.\|sendgrid' dist/             # Must return no results
grep -r 'voiceagent' dist/                       # Must return no results
grep -r 'acme-corp' dist/                        # Must return no results
```

### Step 4: Deploy Firestore Rules

```bash
# Review the rules before deploying
cat firestore.rules

# Deploy to production — requires Firebase project access
firebase deploy --only firestore:rules

# Immediately verify the deployed rules hash matches the file
firebase firestore:rules:get --project parkqueen-46475363-ccf36
```

**Note:** Deploying Firestore Rules is a live, immediate change to production access control. Confirm the emulator test suite passes (Step 2) immediately before this step.

### Step 5: Deploy Storage Rules (when `storage.rules` exists)

```bash
# Only after storage.rules is committed and reviewed
firebase deploy --only storage
```

### Step 6: Deploy Cloud Functions

```bash
cd functions
npm ci           # Functions have their own package.json
cd ..

# Deploy all functions (or specific ones)
firebase deploy --only functions

# Verify deployment
firebase functions:list
```

**Rollback:** If a function deployment fails, the previous version continues serving. To rollback to a specific revision, redeploy the prior commit.

### Step 7: Deploy hosting

```bash
# Build must have been run in Step 2 already
firebase deploy --only hosting
```

After deployment:

```bash
# Verify the deployed version
curl -I https://parkqueen-46475363-ccf36.web.app/
# Check: Content-Security-Policy header present
# Check: X-Content-Type-Options: nosniff
# Check: X-Frame-Options: DENY (or SAMEORIGIN)
```

### Step 8: Smoke test

Open `https://parkqueen-46475363-ccf36.web.app/` in a fresh private window:

- [ ] App loads without console errors
- [ ] Sign-in flow completes (use test phone number)
- [ ] Map renders and shows user location
- [ ] Create a Ping (or verify existing Ping visible)
- [ ] Chat view opens without unauthorized data visible
- [ ] Sign out — confirm session data cleared

### Step 9: Post-deployment monitoring

Check Firebase console within 1 hour of deployment:

- [ ] Function error rate stable (< 5%)
- [ ] Firestore reads within expected range
- [ ] No unexpected billing spike
- [ ] No 401/403 errors in Hosting logs

---

## Rollback procedures

### Hosting rollback

Firebase Hosting maintains a release history. Rollback to the previous release:

```bash
firebase hosting:rollback
```

Or via the Firebase console: Hosting → Release history → select prior release → Roll back.

### Firestore Rules rollback

Rules changes can be rolled back by re-deploying the prior `firestore.rules` file:

```bash
git checkout <prior-commit> -- firestore.rules
firebase deploy --only firestore:rules
git checkout HEAD -- firestore.rules   # restore current version
```

### Functions rollback

Redeploy the prior functions commit:

```bash
git stash
git checkout <prior-commit>
cd functions && npm ci && cd ..
firebase deploy --only functions
git stash pop
```

### Emergency: break-glass incident response

If a critical security incident is detected in production:

1. **Disable sign-in:** Firebase console → Authentication → Sign-in method → Disable all providers temporarily.
2. **Lock Firestore reads:** Deploy a `firestore.rules` that denies all access (`match /{document=**} { allow read, write: if false; }`).
3. **Disable Functions:** Firebase console → Functions → select function → Disable.
4. **Notify team:** Post to incident channel with timestamp, symptom, and initial action taken.
5. **Preserve evidence:** Do not delete logs; capture screenshots of Firebase console metrics.
6. **Root cause:** Investigate after users are protected, not before.
7. **Re-enable:** Only after root cause is confirmed and fix deployed.

---

## Secret management

All secrets are stored in Google Cloud Secret Manager. Do not hard-code secrets in source, functions, or CI variables.

| Secret name | Purpose | Owner to rotate |
|---|---|---|
| `geminiApiKey` | Gemini API access for AI features | Engineering |
| `sendgrid-api-key` (if present) | Email OTP | Engineering |
| `mapbox_token` (if in Secret Manager) | Server-side Mapbox usage | Engineering |

To verify secret versions:

```bash
gcloud secrets list --project parkqueen-46475363-ccf36
gcloud secrets versions list <secret-name> --project parkqueen-46475363-ccf36
```

Do not print secret values. Only verify that active versions exist and are recent.

---

## Firebase Hosting headers

**These are already live.** `firebase.json` is the single source of truth — read the
`hosting.headers` block there rather than this snippet, which is kept only to show the
original shape and has since diverged from production in several ways: the policy is
enforced with a `report-uri` to Sentry, `style-src` needs `'unsafe-inline'` for React's
inline style attributes, `firebaseio.com` was dropped (the app is Firestore-only), no
nonce is used (there are no inline scripts), and `Cache-Control: no-cache` now defaults
on `**` so SPA routes cannot serve stale HTML. Pinned by `utils/cspConfig.test.ts`,
`utils/cspReporting.test.ts` and `utils/hostingCacheControl.test.ts`.

Historical proposal:

```json
"headers": [
  {
    "source": "**",
    "headers": [
      { "key": "X-Content-Type-Options", "value": "nosniff" },
      { "key": "X-Frame-Options", "value": "DENY" },
      { "key": "Referrer-Policy", "value": "strict-origin-when-cross-origin" },
      {
        "key": "Content-Security-Policy",
        "value": "default-src 'self'; script-src 'self' 'nonce-REPLACE'; style-src 'self' https://api.mapbox.com; img-src 'self' data: blob: https://*.mapbox.com; connect-src 'self' https://*.googleapis.com https://*.firebaseio.com https://*.mapbox.com; font-src 'self' https://cdnjs.cloudflare.com; worker-src blob:; frame-ancestors 'none'"
      }
    ]
  },
  {
    "source": "**/*.@(js|css|woff2)",
    "headers": [
      { "key": "Cache-Control", "value": "public, max-age=31536000, immutable" }
    ]
  },
  {
    "source": "/index.html",
    "headers": [
      { "key": "Cache-Control", "value": "no-cache" }
    ]
  }
]
```

**Note:** The CSP `nonce-REPLACE` directive requires server-side nonce injection or a build plugin. For a static SPA, `'unsafe-inline'` may be needed for inline styles with a plan to remove after further refactoring. This must be reviewed by the security lead before deployment.

---

## Deployment frequency and branching

- All deployable changes must originate from reviewed, passing commits on `main`.
- Do not deploy directly from feature branches.
- `audit/app-store-readiness-2026` findings must be cherry-picked to `main` after individual code review, not merged wholesale.
- Never force-push `main`.
- Tag each production deployment per **Release provenance** (`vX.Y.Z` or `deploy/…`). Production release tags must **never** be moved or reused after publication; publish a new tag/Release instead.

---

## Contacts and escalation

| Role | Responsibility |
|---|---|
| Engineering lead | Release authorization, hotfix decisions |
| Security lead | Gate 2 sign-off, Rules deployment approval |
| Firebase project admin | Console access, IAM changes |
| On-call engineer | Post-deployment monitoring, rollback execution |

No deployment step should be executed without at least one additional person reviewing the output.
