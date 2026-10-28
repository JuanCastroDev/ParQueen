# Founder evidence bootstrap

This document records the separately authorized founder action required to introduce founder-signed provenance evidence. It does not perform that action. A green local test is not a GitHub pass.

The live provenance check on main runs the guard from the base branch. This governance change edits that guard and its workflows, so the live check fails closed on this change. The branch is not mergeable through the current check.

## Live ruleset 25926302

Ruleset 25926302, `main provenance gate`, is active on `refs/heads/main`. It requires the GitHub Actions checks `gate` and `private provenance required`, and it includes non-fast-forward protection and deletion protection. `bypass_actors` is empty. For the repository admin, `current_user_can_bypass` is `never`.

Existing repository-owner authority alone cannot merge this governance change. Admin permission does not grant a bypass. Do not disable the ruleset, remove its required checks, or force-push `main`.

## Separately authorized founder action

Do this only after an explicit later founder decision. Do not do it as part of local implementation or a local commit.

1. Independently review and locally test the final governance candidate. Record the full commit SHA that was reviewed.
2. Put only the founder's public key in `scripts/ci/provenance-trust-anchor.json` on that commit before the one-time merge. Set `status` to `active` and choose a `keyId`. Keep the private key outside the repository, GitHub, workflow logs, and test data. This repository does not generate that key.
3. Open a pull request for that exact SHA. Expect `private provenance required` to stay red, because the base-branch guard does not yet accept founder evidence.
4. If the repository settings support it, add only the founder as a temporary PR-only bypass actor on ruleset 25926302. Use bypass mode `pull_request`, which is the pull-request-only mode. Confirm in the GitHub settings that direct pushes remain denied before merging. A PR-only bypass temporarily exempts the selected actor from the relevant ruleset requirements, not just the provenance guard. It must not become permanent.
5. Use that temporary permission only to merge the exact reviewed governance pull request. Record the date, the actor, the ruleset id, and the full commit SHA.
6. Remove the bypass actor immediately afterward. Verify `bypass_actors` is empty again and `current_user_can_bypass` is `never`. Verify the required checks are still `gate` and `private provenance required`, and that non-fast-forward protection and deletion protection are unchanged.

Until an active public key is on `main`, the verifier still fails closed for every provenance-critical change.

## Real signing

Real signing is prohibited until the reviewed governance signer is on main. The signing command compares its own bytes with `refs/heads/main` or `origin/main` before it opens a private key. If those refs differ, or the signer is not on that commit, it refuses. It does not accept a trust anchor or a key path on the command line.

Set `PARQUEEN_PROVENANCE_SIGNING_KEY` to a path outside the repository. The command removes that variable before it loads classification code, and it loads `provenance-change-guard.mjs` only from the `main` blob written to a temporary directory. A pull-request worktree copy is not imported. Run the command from a checkout of that `main` commit, not from a pull-request worktree.

```
node scripts/ci/provenance-evidence.mjs sign --head <sha> --base <sha> --out <path-outside-the-repo> --key-id <id> --executed 11 --passed 11 --failed 0 --skipped 0 --exit-code 0
```

The command records a `FOUNDER-EXECUTED` claim. It does not run the private provenance suite.

## Evidence ref

Publish one Git commit, not a raw blob, to:

`refs/parqueen-provenance/evidence/<40-character-head-sha>`

That commit's tree must contain exactly one blob, `evidence.json`, mode `100644`. The workflows fetch the ref as data. The guard rejects a missing ref, a failed fetch, a blob, a tree, a tag, any other path, and any extra tree entry. It parses `evidence.json` only as untrusted data and checks the Ed25519 signature against the public key on `main`.

Creating that ref is a normal Git ref creation. Replacing the commit is not a fast-forward when the new commit does not descend from the old one, so Git rejects an ordinary update. Ruleset 25926302 does not cover this ref namespace. Anyone with repository write access can still attempt a forced replacement or a deletion. Deletion and an invalid replacement fail closed on the next check. A check that already passed records `evidenceCommit` and the attestation id in the job log. GitHub does not read the ref again at merge time, so a later replacement does not by itself turn a green check red. That stale-green-check risk remains.

Revocation is a trust-anchor change on `main`: set the old key's `status` to `revoked`. Expiry is enforced by the verifier. Maximum lifetime is 30 days.

A remote compatibility probe remains necessary. Local Git tests do not show that GitHub will accept this commit ref or that Actions can fetch it. Do not treat this document as that probe. The probe is a separate founder decision and is not part of local implementation.

This mechanism does not release Street Intelligence, does not close DAS-07, and does not authorize a production deploy.
