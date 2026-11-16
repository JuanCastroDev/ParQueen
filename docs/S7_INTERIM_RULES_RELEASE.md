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

## Approved provisional deployment order (t721u)
Each step needs its own separate founder GO. Nothing here authorizes a step.
1. R1 index.
2. S4 `deleteAccount`.
3. Interim rules (this artifact).
4. S7 callables, including PR-A.
5. PR-B client.
6. Old-client cutoff.
7. Final head rules (`firestore.rules`, with carLocation).
8. Receipt-gated trigger.
9. Legacy interface retirement.

## Deployment safeguards
**This section documents safeguards. It does not authorize running any
deployment command.**

1. **Every production step needs a separate founder GO.** That covers each
   numbered step above and any rollback. A GO for one step does not extend to
   another.
2. **Interim rules are selected only through `firebase.interim-rules.json`.**
   Use `--config firebase.interim-rules.json`. Never copy, rename, symlink or
   otherwise swap `firestore.interim.rules` into `firestore.rules`, and never
   use an untracked or locally edited rules file.
3. **While the interim rules are active (from step 3 until step 7), these are
   prohibited:**
   - a generic `firebase deploy` (no `--only`);
   - `firebase deploy --only firestore`;
   - `firebase deploy --only firestore:rules` with the default `firebase.json`;
   - any other command that targets the default `firestore.rules`.

   With the default `firebase.json`, each of these would publish the final
   head `firestore.rules` early. Head rules drop the legacy arms the Oct 16
   client still needs before the cutoff.
4. **Functions deploys** (step 4 and any later functions step) must name only
   the separately authorized functions:
   `firebase deploy --only functions:<name>[,functions:<name>...] --project <project>`.
5. **Index deploys** must select indexes explicitly, as
   `firebase deploy --only firestore:indexes --project <project>`, and need
   their own authorization. Never combine an index deploy with a rules target.
6. **The final rules (step 7) must not be published before the approved
   old-client cutoff (step 6)** is complete and confirmed. Step 7 is the only
   step that publishes `firestore.rules` through the default `firebase.json`,
   and it needs its own founder GO.
7. **Rollback needs the real production ruleset identifier recorded before
   publication.** Record the live ruleset name and createTime from an
   authorized production read. Do not guess, derive or invent the identifier.
   Until it is recorded the value is `<LIVE_RULESET_NAME: not yet recorded>`
   and `<LIVE_RULESET_CREATE_TIME: not yet recorded>`. With the placeholder
   still in place, the interim rules must not be published.

## Publication command (documented only; do not run without founder GO)
This is step 3. Run it from a clean checkout of the reviewed commit:

```
firebase deploy --config firebase.interim-rules.json --only firestore:rules --project parkqueen-46475363-ccf36
```

Before running it, all of these must hold:
1. A separate founder GO for step 3, after steps 1 (R1 index) and 2 (S4
   `deleteAccount`) are complete.
2. The live ruleset name and createTime are recorded as the rollback target
   (safeguard 7), and the live content still matches the 134a97cf snapshot.
3. The production `activeIncomingClaimRollout/status` value has been read with
   authorization.
4. The checkout's `firestore.interim.rules` digest equals the value above.
5. Rules are published only from reviewed repository sources (F1 control 4).

Rollback: with a separate founder GO, republish the recorded live ruleset
(`<LIVE_RULESET_NAME: not yet recorded>`) by name. Without that recorded name
there is no rollback.

## Not changed
`firebase.json`, `package.json` scripts, CI workflows and `scripts/ci/` are not
changed. No index, function, IAM, App Check or flag change.
