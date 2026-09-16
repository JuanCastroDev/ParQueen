# Curb Intelligence Phase 2A.5: Official DOT Order Relationship Provider

**Date:** 2026-09-16
**Base:** `8e63a5f06051a059844bf228e031f6c6581cf5f3`
**Status:** Approved, production-unwired implementation

## Purpose

Phase 2A deliberately fails DOT cleaning association closed unless an injected
provider establishes an official DOT-order-to-curb relationship. Phase 2A.5
adds that pure relationship layer without adding a live Geoclient adapter,
production execution, persistence, or UI behavior.

## Authoritative research

### Geosupport Function 3C

NYC DCP's Geosupport User Programming Guide v10.1 documents Function 3C as a
blockface operation taking borough, on street, two cross streets, and a compass
side. A successful call establishes that the selected side is a single entire
blockface. It rejects an incompatible compass side, ambiguous three-street
combinations, and a side containing multiple blockfaces. Valid long blockfaces
at T-intersections are supported. Arbitrary multi-block stretches belong to
Function 3S instead.

Function 3C return semantics used by this phase:

- `09`: selected blockface does not exist
- `39`: invalid compass value
- `40`: compass incompatible with segment orientation
- `44`: streets do not define a valid blockface
- `46`: ambiguous blockface
- `50`: street name invalid for that portion

The provider consumes a normalized resolver boundary rather than interpreting
raw Geosupport work areas or Geoclient responses itself.

Source:
`https://maps.nyc.gov/geoclient/v1/download/geosupport-user-programming-guide-v10.1.pdf`

### DOT order geometry

The official Parking Regulation Locations and Signs data dictionary defines
the literal `order_type` values used here:

- `P-`: block-front order with meters
- `S-`: block-front order without meters
- `B-`: blanket/multi-block stretch

Geometry classification therefore comes from normalized `orderType`, not from
the visually similar prefix in `orderNumber`. Current rows sharing an order are
order-level evidence and must agree on their material relationship context.

Source dataset:
`https://data.cityofnewyork.us/Transportation/Parking-Regulation-Locations-and-Signs/nfid-uabd`

### Suffixes and roadbeds

DOT documents `on_street_suffix`, `from_street_suffix`, and
`to_street_suffix` for locations where streets intersect more than once or an
additional roadbed must be distinguished. The audited source contains values
such as `W RDWY`, `N S/R`, and `E RDWY`. No authoritative translation from
these suffixes to a Function 3C/Geoclient input was found.

Every nonblank suffix is therefore explicit `UNKNOWN`. It is never stripped.
The public Bay Street order `P-01683639` is corrected to retain `W RDWY` and
now fails cleaning association closed.

### Sign coordinates

The DOT dictionary labels `sign_x_coord` and `sign_y_coord` as longitude and
latitude while published values are not ordinary WGS84 coordinates. No
authoritative dataset-specific CRS declaration was found. Phase 2A.5 does not
use these fields for official relationship support and does not infer
EPSG:2263.

### Block Face ID

Official CSCL metadata defines left/right Block Face ID as a ten-digit identity
for one continuous side of a physical block. Phase 2A.5 reuses the existing
string-safe `normalizeBlockFaceId` implementation and performs exact normalized
equality only.

Source:
`https://github.com/CityOfNewYork/nyc-geo-metadata/blob/main/Metadata/Metadata_StreetCenterline.md`

## Provider boundary

```js
createOfficialDotRelationshipProvider({
  blockfaceResolver,
  providerId,
})
```

The injected resolver contract is:

```js
blockfaceResolver.resolve({
  borough,
  onStreet,
  crossStreetOne,
  crossStreetTwo,
  compassDirection,
  signal,
})
```

Successful normalized evidence contains:

```js
{
  ok: true,
  officialBlockFaceId,
  normalizedStreetNames: {
    onStreet,
    crossStreetOne,
    crossStreetTwo,
  },
  returnCode,
  reasonCode,
  sourceVersion,
}
```

The caller's `AbortSignal` is passed through unchanged. Resolver exceptions and
raw response text are discarded.

## WHOLE_FACE requirements

An order is `WHOLE_FACE` only when all conditions hold:

1. The DOT candidate snapshot is complete.
2. Snapshot and candidate source versions are valid and identical.
3. All rows are current and have a valid order identity.
4. Every row in the order agrees on geometry class, borough, on/from/to
   streets, compass side, and all suffix fields.
5. Official `order_type` is exactly `P-` or `S-`.
6. Borough, on street, both cross streets, and compass side are complete.
7. All suffixes are blank.
8. The authoritative resolver succeeds with reviewed normalized fields.
9. Resolver provenance/version is present and stable across the snapshot.
10. Returned BFI exactly equals the Phase 1 official BFI.
11. No contradictory evidence exists.

BFI equality alone is insufficient.

## UNKNOWN behavior

Every examined order is explicitly present in `orderApplicability`; unresolved
orders are never omitted. Reasons are bounded to reviewed low-cardinality codes:

- `official_blockface_lookup_unavailable`
- `official_blockface_lookup_failed`
- `official_blockface_ambiguous`
- `official_blockface_mismatch`
- `dot_order_location_incomplete`
- `dot_order_location_conflict`
- `dot_suffix_unresolved`
- `dot_stretch_requires_decomposition`
- `dot_geometry_applicability_unknown`
- `candidate_source_incomplete`
- `source_version_mismatch`

Phase 2A.5 does not infer `PARTIAL_FACE`. A future authoritative provider may
add that state when it has a reviewed partial interval model.

## Public fixture implications

- Chatham: exact relationship can be `WHOLE_FACE`; cleaning remains `UNKNOWN`
  because curb identity is `UNKNOWN`.
- Gold: `WHOLE_FACE`, cleaning `SUPPORTED`.
- St James: `WHOLE_FACE`, cleaning capped to `CAUTION`.
- East 170: no current DOT cleaning order, cleaning `UNKNOWN`.
- Pierrepont: `WHOLE_FACE`, cleaning capped to `CAUTION`.
- Prince: `WHOLE_FACE`, cleaning `SUPPORTED`.
- Bay: `W RDWY` suffix unresolved, explicit `UNKNOWN`, cleaning `UNKNOWN`.
- William: no current DOT cleaning order, cleaning `UNKNOWN`.
- Queens 33: `WHOLE_FACE`, cleaning capped to `UNKNOWN`.

These are deterministic provider-contract fixtures. They are not represented as
live Geoclient validation.

## Production and privacy boundary

There is no live network adapter and no Geoclient key. The new module is not
wired into `functions/index.js` or `createSegmentFromSweepNYC`. It creates no
Firestore schema, writes no telemetry, schedules no work, persists no BFI/order
identity, and accepts no user GPS. Provider diagnostics remain internal runtime
data; aggregate telemetry keeps its existing privacy-safe allowlist.

## Deferred

- Approved Geoclient subscription and live adapter, or an equivalent local
  Geosupport implementation
- Authoritative DOT suffix/additional-roadbed translation
- Function 3S stretch decomposition
- Authoritative partial-face interval semantics
- Production wiring and rollout decisions
