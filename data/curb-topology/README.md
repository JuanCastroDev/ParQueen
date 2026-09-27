# Canonical curb topology data boundary

This directory contains metadata only. `manifest.json` pins the official source evidence used for the Phase 2A.35B report; `manifest.template.json` documents the contract.

Raw snapshots belong in `snapshots/` and generated private shards belong in `artifacts/`. Both directories are gitignored and must never be copied to `public/`, `dist/`, Hosting, or a browser import graph.

Run `npm run test:curb-topology` for the offline contract suite. After separately acquiring the pinned official snapshots, run `npm run build:curb-topology`. The builder validates all sizes, row counts, fields, and SHA-256 digests before creating an output directory.
