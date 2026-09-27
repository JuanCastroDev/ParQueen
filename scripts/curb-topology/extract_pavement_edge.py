"""Download a version-stable official NYC Pavement Edge snapshot to NDJSON."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
from urllib.parse import urlencode
from urllib.request import urlopen

from extract_cscl import canonical_json


RESOURCE_ID = "vs44-rznx"
METADATA_URL = f"https://data.cityofnewyork.us/api/views/{RESOURCE_ID}"
DATA_URL = f"https://data.cityofnewyork.us/resource/{RESOURCE_ID}.json"
SELECT = "source_id,feat_code,sub_code,status,blockf_id,conflated,the_geom"


def fetch_json(url: str):
    with urlopen(url, timeout=120) as response:  # nosec: official fixed endpoints only
        return json.load(response)


def source_version(metadata: dict) -> str:
    updated = metadata.get("rowsUpdatedAt")
    if not isinstance(updated, int) or updated <= 0:
        raise RuntimeError("Pavement Edge rowsUpdatedAt is unavailable")
    return f"{RESOURCE_ID}-rows-{updated}"


def extract(output: Path, page_size: int = 50000) -> dict[str, object]:
    before = fetch_json(METADATA_URL)
    version = source_version(before)
    output.parent.mkdir(parents=True, exist_ok=True)
    digest = hashlib.sha256()
    row_count = 0
    fields: set[str] = set()
    with output.open("wb") as handle:
        offset = 0
        while True:
            query = urlencode({
                "$select": SELECT,
                "$order": "source_id",
                "$limit": page_size,
                "$offset": offset,
            })
            rows = fetch_json(f"{DATA_URL}?{query}")
            for row in rows:
                fields.update(row.keys())
                line = (canonical_json(row) + "\n").encode("utf-8")
                handle.write(line)
                digest.update(line)
            row_count += len(rows)
            if len(rows) < page_size:
                break
            offset += len(rows)
    after = fetch_json(METADATA_URL)
    if source_version(after) != version:
        output.unlink(missing_ok=True)
        raise RuntimeError("Pavement Edge changed during acquisition")
    return {
        "path": output.name,
        "rowCount": row_count,
        "byteSize": output.stat().st_size,
        "sha256": digest.hexdigest(),
        "fields": sorted(fields),
        "releaseId": version,
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--page-size", default=50000, type=int)
    args = parser.parse_args()
    if args.page_size < 1 or args.page_size > 50000:
        raise SystemExit("page size must be between 1 and 50000")
    print(canonical_json(extract(args.output.resolve(), args.page_size)))


if __name__ == "__main__":
    main()
