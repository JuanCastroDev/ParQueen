# Canonical Curb Topology Artifact

## Scope

Phase 2A.35B provides offline evidence tooling only. It does not import into `functions/index.js`, alter a callable, change the canonical resolver, create `CURB_CANONICAL_V2_NEXT`, enable recovery, modify Firebase/Hosting configuration, or expose topology data to a browser.

The governing architecture remains `docs/CANONICAL_CURB_RECOVERY_DESIGN.md`. In particular, authoritative CSCL `intersects` remains the future primary retrieval contract, `within_circle` remains diagnostic/shadow only, and Pavement Edge remains secondary recovery evidence. This phase does not implement any of those runtime reads.

## Official sources and pinned releases

The committed metadata manifest is `data/curb-topology/manifest.json`.

| Role | Official source | Pinned update | Rows |
| --- | --- | ---: | ---: |
| Centerline | NYC DCP Published CSCL File Geodatabase, ArcGIS item `9163b04952354da2bf748abe1788e985` | item modified `1790471518000` | 122,311 |
| Node | same CSCL Pub release | same | 79,250 |
| StreetName | same CSCL Pub release | same | 69,726 |
| Pavement Edge | NYC Open Data `vs44-rznx` | `rowsUpdatedAt=1714164498` | 178,947 |

The CSCL Pub zip SHA-256 observed during acquisition was `8c73c622949e4cad5676113c0d1f030248d06ef28b162114627702d5b2ef1d35`. The normalized layer and Pavement Edge digests are pinned separately in the manifest.

Only official NYC sources establish evidence. Mapbox, reverse geocoding, SweepNYC, and ParQueen caches are not inputs.

## Acquisition and refresh

1. Download the official CSCL Pub file geodatabase from the manifest URL.
2. Extract its `Centerline`, `Node`, and `StreetName` layers with `scripts/curb-topology/extract_cscl.py`. The adapter reprojects spatial layers to EPSG:4326, emits canonical NDJSON, converts missing table values to JSON `null`, and records row count, fields, bytes, and SHA-256.
3. Acquire Pavement Edge with `scripts/curb-topology/extract_pavement_edge.py`. It pages in deterministic `source_id` order and refuses the snapshot if `rowsUpdatedAt` changes between the pre- and post-download metadata reads.
4. Update the manifest only from the resulting inventories. All three CSCL roles must have the same release ID.
5. Run `npm run test:curb-topology` and then `npm run build:curb-topology`.
6. Rebuild into a second empty directory and compare `index.json` plus every shard digest. Performance reports are measured separately and are not reproducibility inputs.
7. Review the aggregate report and re-run the later benchmark before any artifact is considered for runtime use.

Raw snapshots and generated shards live under gitignored `data/curb-topology/snapshots/` and `data/curb-topology/artifacts/`. They are not committed.

## Manifest contract

Each source declares its official URL and resource ID, release/update ID, supported adapter schema, byte size, row count, SHA-256, required fields, and shared normalization version. Acquisition time is explicit metadata but is excluded from the deterministic manifest identity.

The builder validates the entire inventory before creating its output directory and fails closed on:

- a missing source, field, digest, release ID, or schema;
- byte, row-count, or SHA-256 mismatch;
- duplicate roles or incompatible CSCL releases; or
- unsupported normalizer input.

## Normalization

BFIs accept only non-zero base-10 integer values from 1–10 digits and are rendered as ten digits. Floats, exponent notation, whitespace, signs, silent truncation, values wider than ten digits, and unsafe integers are rejected. Zero and absent official block-face fields normalize to missing evidence rather than an identity.

The official Pavement Edge snapshot contains only string `CONFLATED` encodings: `"0"` in 14,574 rows and `"1"` in 164,373 rows. The normalizer also supports numeric `0` and `1` for documented export variability, while rejecting all other encodings.

The StreetName export omits `OBJECTID`, so that field is optional. One official StreetName row contains a six-digit `B7SC`; it is classified as invalid and never padded or used. The Centerline layer itself supplies a valid direct eight-digit B7SC for every topology-complete record.

## Topology construction

Records are grouped by normalized BFI. The authoritative left/right block-face field determines logical side. Every group must have one borough, one roadway/name context, one source version, compatible levels, compatible roadbed evidence, and a directed non-branching segment chain.

The downloadable CSCL Pub release does not publish the full internal `NodesHaveSegments` relationship. Therefore this artifact uses the architecture-approved fallback: each Centerline endpoint must exactly equal one and only one official Node coordinate after seven-decimal normalization. There is no nearest-node search. The fallback remains labeled `geometry_node_fallback` and is quantified separately; it is not described as an explicit relationship.

At each resulting endpoint, incident official Centerline records establish intersecting street candidates. Supporting segments and the on-street B5SC are excluded. Exactly one non-equivalent candidate is required at both endpoints. Zero candidates yields `incomplete`; multiple candidates yields `ambiguous`; side, level, roadbed, source, roadway, or chain disagreement yields `conflict`. No alphabetical tie-breaker, nearest name, or reverse geocoder is used.

Only `complete` records enter the correctness-eligible artifact. Function 3C remains mandatory in the future runtime architecture and is not called in this phase.

## Artifact schema and privacy

Each schema-v1 private record contains the source manifest/release, BFI, borough, CSCL side, official on-street B5SC/B7SC and display name, supporting PhysicalIDs, roadway status/type, level/roadbed evidence, exact endpoint Node IDs, official endpoint street candidates, derivation method, topology state, and provenance.

The generated artifact excludes raw geometry. The offline model retains digitization-direction evidence while building, but a future runtime can combine the official candidate geometry with the artifact's CSCL side; no client-visible identity is introduced.

Static tests reject client or deployed-Functions imports of the offline boundary and detect topology shards under `public/` or `dist/`. BFIs, Node IDs, PhysicalIDs, source IDs, source geometry, and full topology records remain server/private.

The small committed fixture at `scripts/curb-topology/fixtures/public-official-records.json` contains only public official evidence and an explicit 12-case catalog. Borough examples retain official record IDs; intersection, divided-road, reversal, ambiguity, and conflict cases are deterministic transformations of the public seed used to prove fail-closed behavior, never owner or production observations.

## Sharding and measurements

Two deterministic strategies were measured over 120,799 complete records:

- decimal prefix: 128 shards, highly imbalanced (27–1,000 records per shard);
- SHA-256 hash prefix: 256 shards, 404–532 records per shard.

The selected strategy is a two-hex-character SHA-256 prefix. Filenames, record ordering, canonical JSON bytes, shard bounds, per-shard SHA-256, min/max BFI ranges, and the top-level index are deterministic. Exact lookup verifies the shard digest before parsing and caches the shard after first use.

Measured output is 126,157,895 bytes across 256 shards. Shard sizes range from 421,366 to 555,361 bytes (median 493,417; p95 527,069). Generation took about 41 seconds with observed RSS around 1.3 GB. The 100-sample lookup simulation measured a 4.6882 ms median cold lookup and 0.0067 ms median warm lookup; disk cache and host conditions can change timing.

Two full builds produced 257/257 identical index/shard files and zero byte differences.

## Delivery recommendation

Use bundled lazy shards for the first controlled runtime experiment, subject to the later deployment-package and discovery-time gate. The 126.2 MB uncompressed artifact is material but remains below the platform's broad uncompressed package boundary, can be loaded one roughly 0.5 MB shard at a time, requires no new bucket/IAM/configuration, and pins rollback to a code deployment. It must not be eagerly imported or parsed during Functions discovery.

Private object storage would reduce deployment-package weight and decouple refreshes, but it adds object publication, IAM, network availability, cache invalidation, and a second version-pinning surface. No bucket or IAM change is made here. Reconsider object storage if the controlled packaging/discovery test rejects the bundled size.

## Known coverage gaps and transition criteria

- 74.5305% of CSCL BFIs are topology-complete. Ambiguous, incomplete, and conflicting records remain unusable.
- Public CSCL Pub relationships require exact geometry-to-Node fallback for 156,231 classified BFI records; no complete BFI is represented as an explicit segment-node relation.
- One StreetName B7SC is invalid, although direct Centerline B7SC coverage is 100% for complete records.
- Exact Pavement Edge reconciliation succeeds for 121,383 valid conflated rows. Failures remain closed: 41,491 have incomplete topology and 1,381 have no CSCL BFI.
- Performance numbers are workstation measurements, not callable latency guarantees.

Phase 2A.35C may begin only after review approves this evidence and artifact design. That phase, not this one, owns the frozen 5,000-point benchmark, Function 3C verification, authoritative `intersects` comparison, package/discovery validation, and any runtime proposal. Recovery remains disabled.
