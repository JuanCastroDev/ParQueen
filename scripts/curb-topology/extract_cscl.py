"""Extract public CSCL Pub layers to deterministic NDJSON for offline tooling.

This adapter requires pyogrio/geopandas for a downloaded file geodatabase.
It performs projection only; all semantic validation remains in the Node
normalizers and builder.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
from pathlib import Path


LAYERS = {
    "Centerline": "cscl-centerline.ndjson",
    "Node": "cscl-node.ndjson",
    "StreetName": "cscl-street-name.ndjson",
}


def json_default(value: object) -> object:
    """Encode official date values deterministically without coercing other types."""
    isoformat = getattr(value, "isoformat", None)
    if callable(isoformat):
        return isoformat()
    raise TypeError(f"Object of type {value.__class__.__name__} is not JSON serializable")


def normalize_json_value(value: object) -> object:
    if isinstance(value, float) and math.isnan(value):
        return None
    if isinstance(value, dict):
        return {key: normalize_json_value(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [normalize_json_value(item) for item in value]
    return value


def canonical_json(value: object) -> str:
    return json.dumps(
        normalize_json_value(value),
        default=json_default,
        allow_nan=False,
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
    )


def iter_records(frame: object):
    """Yield GeoJSON features or plain records for non-spatial GDB tables."""
    iterfeatures = getattr(frame, "iterfeatures", None)
    if callable(iterfeatures):
        yield from iterfeatures(drop_id=True)
        return
    yield from frame.to_dict(orient="records")


def extract(gdb: Path, output: Path) -> dict[str, dict[str, object]]:
    try:
        import pyogrio
    except ImportError as exc:  # pragma: no cover - environment boundary
        raise SystemExit("pyogrio and geopandas are required for CSCL extraction") from exc

    output.mkdir(parents=True, exist_ok=True)
    inventory: dict[str, dict[str, object]] = {}
    for layer, filename in LAYERS.items():
        frame = pyogrio.read_dataframe(gdb, layer=layer)
        if getattr(frame, "crs", None) is not None:
            frame = frame.to_crs(4326)
        target = output / filename
        digest = hashlib.sha256()
        with target.open("wb") as handle:
            for record in iter_records(frame):
                line = (canonical_json(record) + "\n").encode("utf-8")
                handle.write(line)
                digest.update(line)
        inventory[layer] = {
            "path": filename,
            "rowCount": len(frame),
            "byteSize": target.stat().st_size,
            "sha256": digest.hexdigest(),
            "fields": sorted(column for column in frame.columns if column != "geometry"),
        }
    return inventory


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--gdb", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    inventory = extract(args.gdb.resolve(), args.output.resolve())
    print(canonical_json(inventory))


if __name__ == "__main__":
    main()
