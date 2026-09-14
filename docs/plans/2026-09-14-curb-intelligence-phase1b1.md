# Curb Intelligence Phase 1B.1 implementation plan

## Boundary

Build an additive, shadow-only official NYC ingestion and curb-resolution foundation under `functions/curbIntelligence/`. Do not wire it into `functions/index.js`, Firestore, UI, telemetry, schedulers, Android/native code, or production.

## RED/GREEN sequence

1. **CSCL normalization**
   - Add failing tests for complete field preservation, string-only Block Face IDs, GeoJSON `MultiLineString` validation, malformed-row reasons, and source version separation.
   - Implement `csclNormalizer.js` using the Phase 1A identity rules.

2. **SND COW parsing and alias provenance**
   - Add failing tests based on small official-format records for record ordinal/type/key, borough, source-native name, B5SC/B7SC/B10SC/local group, and principal/preferred flags.
   - Prove unrelated spelling, service-road, directional, bridge, and viaduct names do not collapse.
   - Implement `sndNormalizer.js` with official-code relationships only.

3. **Versioned ingestion boundary**
   - Add failing tests for stable CSCL page ordering, deterministic SND record paging, release `26b`, locally computed archive SHA-256, deterministic statistics, malformed rows, and source changes during ingestion.
   - Implement dependency-injected CSCL page and SND archive readers in `sourceIngest.js`; keep release identity and archive digest distinct.

4. **Candidate-store contract**
   - Add failing tests for bounded envelope/radius queries and explicit `COMPLETE`/`INCOMPLETE` completeness.
   - Implement only an in-memory deterministic adapter in `candidateStore.js`.

5. **Physical roadway grouping**
   - Add failing tests for connected records sharing official face/roadbed evidence across different `physicalid` values, plus divided roads, service roads, levels, incompatible types, and unresolved groups.
   - Implement `roadwayGrouping.js`; treat `physicalid` as supporting evidence only.

6. **Curb resolver**
   - Add failing tests for broad retrieval, exact metric ranking, meaningful competitors, signed side selection, missing BFI, intersection/endpoint ambiguity, service/main roadways, parallel roadbeds, bridges/levels, and excellent/moderate/poor GPS.
   - Implement `curbResolver.js` around the unchanged Phase 1A geometry and confidence helpers. Search-radius policy remains at the resolver/store boundary.

7. **Canonical cleaning fingerprints**
   - Add failing tests for weekday order, duplicate weekdays, schedule-array order, duplicate schedules, and multi-schedule stability.
   - Implement `cleaningFingerprint.js` and narrowly extend the existing shadow fingerprint grammar for canonical schedule sets.

8. **Shadow result and public fixtures**
   - Add failing privacy tests that reject raw/reversible location, geometry, geohash, address, and Block Face ID fields.
   - Extend the nine small public NYC fixtures with official geometry/naming evidence and expected supported/caution/unknown outcomes.
   - Implement a resolver-to-shadow mapper that retains internal provenance but emits only the Phase 1A persistable comparison fields.

9. **Verification and local commit**
   - Run all Phase 1A and Phase 1B.1 tests, NYC parser tests, Street Intelligence confidence/presentation tests, full root suite, TypeScript, no-upload Vite build, and `git diff --check`.
   - Run current-tree and exact-range Gitleaks plus artifact, credential, dataset-size, private-GPS, and shadow-privacy checks.
   - Review the exact diff for additive-only scope, then create one local commit. Do not push, open a PR, merge, or deploy.

## Planned production-file boundary

- `functions/curbIntelligence/csclNormalizer.js`
- `functions/curbIntelligence/sndNormalizer.js`
- `functions/curbIntelligence/sourceIngest.js`
- `functions/curbIntelligence/candidateStore.js`
- `functions/curbIntelligence/roadwayGrouping.js`
- `functions/curbIntelligence/curbResolver.js`
- `functions/curbIntelligence/cleaningFingerprint.js`
- `functions/curbIntelligence/shadowResult.js`
- Narrow Phase 1A contract/fixture extensions only where required
- Corresponding focused tests and small public fixtures

## Fail-closed rules

- No `OBJECTID` identity and no numeric Block Face conversion.
- No name-only, fuzzy, phonetic, proximity-only, or `physicalid`-only grouping.
- Incomplete candidate retrieval cannot produce `SUPPORTED`.
- Missing or conflicting official identity, aliases, level/type evidence, source versions, or source consistency remains explicit.
- Raw GPS is request-local and never enters persistable shadow output.
