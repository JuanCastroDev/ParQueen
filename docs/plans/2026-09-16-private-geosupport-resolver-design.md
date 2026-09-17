# Private Geosupport Resolver Design

## Scope

Phase 2A.8 is a local-only implementation spike for a private HTTP boundary around the pinned NYC Geosupport 26C runtime. It adds no deployment, IAM, Firebase, client, or production wiring.

## Process and containment model

The service runs under Gunicorn with exactly one synchronous worker and one thread. The worker loads `libgeo` once and performs at most one native Function 3C call at a time. Each request gets one attempt and no retry.

Gunicorn owns native-call containment. Its bounded worker timeout is allowed to terminate and recreate a worker that hangs in native code. The application does not cancel threads and does not create a subprocess or process pool per request.

## HTTP contract

The lookup endpoint accepts JSON with exactly these fields:

- `borough`: one canonical NYC borough name
- `onStreet`, `crossStreetOne`, `crossStreetTwo`: non-empty ASCII strings within the reviewed 32-byte Geosupport field limit
- `compassDirection`: one of `N`, `S`, `E`, or `W`

Unknown fields, missing fields, non-JSON bodies, wrong types, invalid boroughs, non-ASCII text, empty street fields, and over-limit street fields are rejected before the native layer is called. Borough names are mapped internally to the reviewed Geosupport borough codes.

`POST /resolve-blockface` returns authoritative success as `officialBlockFaceId` string data together with normalized provider street names, GRC/reason codes, and compact source-version metadata. Rejected provider responses return only the return code, reason code, and a stable failure classification. They never return a Blockface ID or provider message text.

## Native contract

The adapter calls the pinned `26.3.0` image's `libgeo` Function 3C entry point directly. It uses mutable, space-filled work areas sized for the empirically reviewed release-specific boundary: 1200 bytes for work area 1 and 1000 bytes for work area 2.

This is not a universal Geosupport ABI. The release-specific offsets and sizes are isolated in the adapter and covered by tests. The application parses the GRC before reading any identity field. Only GRC `00` can yield a trusted ten-digit Blockface ID. Every other GRC fails closed as `UNKNOWN`, even if output memory contains identity-looking bytes.

## Logging and privacy

Gunicorn access logging is disabled. Application logs are structured and low-cardinality: event, outcome, sanitized return-code category, latency, and service version. Request bodies, street names, boroughs, Blockface IDs, IP addresses, native messages, exceptions, and raw work areas are never logged or returned.

## Health and failure behavior

The health endpoint reports only service readiness and compact pinned provider version metadata. Validation failures are HTTP 400. Non-authoritative provider results are a fail-closed HTTP 200 domain response. Native availability or contract failures are sanitized HTTP 503 responses.

The Gunicorn worker timeout is 10 seconds. A future Cloud Run request timeout should be 15 seconds so worker termination precedes the platform deadline. A timed-out worker may cause a connection-level or gateway failure; callers must treat that as `UNKNOWN` and must not retry automatically.

## Verification boundary

Injected-result tests cover request validation, borough mapping, response normalization, stale-identity suppression, sequential native execution, health, and log redaction. The final local container test uses the six pinned public fixtures: five must exactly match Phase 1 Blockface IDs, and St James must remain a safe Function 3C rejection.

## Supply chain

The container base is pinned by tag and digest. Python dependencies are version-pinned. The runtime uses the image's direct native library and does not use the third-party Python wrapper call layer. Any future runtime, image, dependency, or Geosupport release change requires explicit review and fixture revalidation.
