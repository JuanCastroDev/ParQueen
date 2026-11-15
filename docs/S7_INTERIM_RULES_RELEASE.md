# S7 interim Firestore rules: release artifact and selection (t721u)

**Status: prepared, NOT published.** Publishing requires separate founder
authorization. S4, S7 and A5 remain NO_GO and the production freeze is active.

## Artifact and source identity
| Item | Value |
|---|---|
| Release artifact | `firestore.interim.rules`, sha256 `f399f61765aa3738a49af49888772b87d35ea1b0cceb3a8a39cae11523479369` |
| Rules body (from `rules_version` to end of file) | sha256 `566ee4dcc44e3d676b8eb265aa440b99778220d7162757e86440fcc875038e57`, byte-identical to the reviewed candidate body |
| Reviewed candidate | `test-fixtures/interim-candidate/firestore.interim-legacy-hardened.rules`, sha256 `c1508fa02a15fff9b3a2d4a965d40254f540c7c69ffe5aed6405c0a6bb090400` (t684u/t685u correction; PR #332 head `f3b5831a`) |
| Production base | `test-fixtures/production-baseline/deployed-firestore-134a97cf.rules`, sha256 `134a97cf8e25f2f8848ff4d2c0ff65ff5dd83434f1690901b4ba7dffe403810b` |

Only the header comment differs from the candidate. `firestore.rules.test.interim-release.ts`
pins the candidate digest, the body identity, the artifact digest, the selector
and carLocation parity. The candidate's behavior is proven by
`firestore.rules.test.interim-legacy-hardened.ts` and
`firestore.rules.test.interim-expression-budget.ts`.

## Selection
- `firebase.json` is unchanged and still targets `firestore.rules` (final head
  rules, published only after the A5 cutoff).
- `firebase.interim-rules.json` is the only file that selects the interim
  artifact. It contains a Firestore rules target and nothing else: no indexes,
  functions, hosting or storage, so it cannot deploy anything else.
- No temporary swap of `firestore.rules` is used.

## Publication command (documented only; do not run without founder GO)
From a clean checkout of the reviewed commit:

```
firebase deploy --config firebase.interim-rules.json --only firestore:rules --project parkqueen-46475363-ccf36
```

Before running it, all of these must hold:
1. Founder GO for this step, in the order approved in t721u (after R1 index and
   the S4 `deleteAccount` deploy; before the S7 parking callables).
2. The live ruleset name and createTime are recorded (the rollback target),
   and the live content still matches the 134a97cf snapshot.
3. The production `activeIncomingClaimRollout/status` value has been read with
   authorization.
4. The checkout's `firestore.interim.rules` digest equals the value above.
5. Rules are published only from reviewed repository sources (F1 control 4).

Rollback: republish the recorded live ruleset by name. Without that recorded
name there is no rollback.

## Not changed
`firebase.json`, `package.json` scripts, CI workflows and `scripts/ci/` are not
changed. No index, function, IAM, App Check or flag change.
