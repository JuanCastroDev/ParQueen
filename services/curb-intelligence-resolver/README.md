# Private Curb Intelligence Resolver

Local Phase 2A.8 spike for a private NYC Geosupport Function 3C boundary. This directory contains no deployment, IAM, Firebase, or client wiring.

## Runtime contract

- Pinned Geosupport Desktop Edition release `26C`, version `26.3.0`
- Direct `libgeo` integration; the third-party Python wrapper call layer is not used
- Mutable 1200-byte WA1 and 1000-byte WA2 buffers for this reviewed release only
- GRC is parsed before identity; only `00` can produce a trusted ten-digit string BFI
- Every other GRC returns fail-closed `NOT_AUTHORITATIVE` without identity data
- One Gunicorn sync worker, one thread, one native attempt per request, no retry
- Gunicorn worker timeout: 10 seconds; proposed future Cloud Run request timeout: 15 seconds

The native sizes and offsets are release-specific observations, not a universal Geosupport ABI. Any Geosupport release or image change requires a fresh contract review and full fixture validation.

## Attribution and release review

Geosupport Desktop Edition™ copyrighted by the New York City Department of City Planning.

This attribution does not imply NYC DCP endorsement. Every quarterly Geosupport release upgrade requires native ABI/contract revalidation, fixture validation, a resolver image rebuild and review, and separate rollout approval. Written NYC DCP confirmation concerning long-running private cloud-container use remains recommended before broad reliance.

## HTTP API

`POST /resolve-blockface` accepts exactly:

```json
{
  "borough": "MANHATTAN",
  "onStreet": "GOLD STREET",
  "crossStreetOne": "BEEKMAN STREET",
  "crossStreetTwo": "ANN STREET",
  "compassDirection": "W"
}
```

Canonical boroughs are `MANHATTAN`, `BRONX`, `BROOKLYN`, `QUEENS`, and `STATEN ISLAND`. Street fields must be non-empty ASCII and no more than 32 bytes. Compass direction must be `N`, `S`, `E`, or `W`. Extra fields are rejected.

`GET /health` reports only readiness and compact provider version metadata.

Access logging is disabled. Operational logs contain only a stable event name, outcome, sanitized return code, latency, and service version.

## Local verification

```sh
python -m pip install -r requirements-dev.txt
python -m pytest -q
docker build -t parqueen-curb-resolver:2a8 .
docker run --rm --name parqueen-curb-resolver-2a8 -p 127.0.0.1:18080:8080 parqueen-curb-resolver:2a8
python tests/run_container_fixtures.py
```

The local fixture gate requires five exact Phase 1 BFIs and one safe St James rejection. Do not publish the image or treat this spike as deployment authorization.
