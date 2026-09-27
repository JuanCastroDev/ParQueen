# Canonical Curb Topology Quality Report

Pinned manifest: `a10c60fad0ebb31c29bc89ae5cd7b32020707004b3438610dccee9897d6efaec`

## Source and normalization

- Centerline rows: 122,311
- Node rows: 79,250
- StreetName rows: 69,726
- Pavement Edge rows: 178,947
- Pavement `CONFLATED="1"`: 164,373
- Valid conflated edges with BFI: 164,255
- Missing BFI rows: 1,435
- Invalid BFI rows: 0
- Invalid StreetName B7SC rows: 1 (not padded or used)

## Topology

| State | BFIs | Percent of 162,080 |
| --- | ---: | ---: |
| Complete | 120,799 | 74.5305% |
| Ambiguous endpoint context | 14,910 | 9.1992% |
| Incomplete | 20,522 | 12.6616% |
| Conflicting evidence | 5,849 | 3.6087% |

160,593 BFIs map to exactly one CSCL side; 1,487 BFIs have an explicit side conflict. Complete topology by borough is Manhattan 10,637; Bronx 14,874; Brooklyn 32,366; Queens 47,614; and Staten Island 15,308.

The published release contains no usable explicit segment-node relationship: 156,231 classified BFIs use the exact endpoint-to-official-Node fallback and 5,849 have no usable endpoint method because they fail earlier/at the chain contract.

## Reconciliation and B7SC

- Pavement Edge rows reconciled exactly: 121,383
- Rejected for incomplete topology: 41,491
- Rejected because BFI is absent from CSCL: 1,381
- B5SC/B7SC finding: **YES** for the correctness-eligible population
- Complete BFIs with direct segment-local B7SC: 120,799 / 120,799 (100%)

No B7SC is synthesized. The single malformed StreetName value is unrelated to the direct Centerline coverage and remains unusable.

## Artifact and performance

- Strategy: two-character SHA-256 hash prefix
- Artifact records: 120,799
- Shards: 256
- Total bytes: 126,157,895
- Shard bytes min / median / p95 / max: 421,366 / 493,417 / 527,069 / 555,361
- First measured generation: 41,368.1322 ms
- Observed RSS: 1,328,001,024 bytes
- Cold lookup median / p95 / max: 4.6882 / 6.395 / 128.2530 ms
- Warm lookup median / p95 / max: 0.0067 / 0.043 / 0.0718 ms
- Reproducibility: 257 files in each build, zero digest/length differences

Recommendation: bundled lazy shards for the first controlled packaging experiment, with private object storage retained as the fallback if deployment-package or discovery-time validation rejects the 126.2 MB addition. No runtime wiring, bucket, IAM, deployment, or configuration mutation occurred.
