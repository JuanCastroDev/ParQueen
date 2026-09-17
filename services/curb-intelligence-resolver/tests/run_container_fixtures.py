import json
import sys
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


BASE_URL = "http://127.0.0.1:18080"


def fetch_json(path, payload=None):
    body = None if payload is None else json.dumps(payload).encode("ascii")
    request = Request(
        f"{BASE_URL}{path}",
        data=body,
        headers={"Content-Type": "application/json"} if body else {},
        method="POST" if body else "GET",
    )
    try:
        with urlopen(request, timeout=5) as response:
            return response.status, json.load(response)
    except HTTPError as error:
        return error.code, json.load(error)


def main():
    health_status, health = fetch_json("/healthz")
    if health_status != 200 or health.get("ok") is not True:
        raise AssertionError("resolver health check failed")

    fixtures = json.loads(
        (Path(__file__).with_name("fixtures.json")).read_text(encoding="ascii")
    )
    successes = 0
    exact_matches = 0
    safe_rejections = 0

    for fixture in fixtures:
        status, result = fetch_json("/resolve-blockface", fixture["request"])
        if status != 200:
            raise AssertionError(f"{fixture['name']}: unexpected HTTP {status}")
        if fixture.get("expectedUnknown"):
            if result.get("ok") is not False or "officialBlockFaceId" in result:
                raise AssertionError(f"{fixture['name']}: rejection was not fail-closed")
            safe_rejections += 1
            continue

        if result.get("ok") is not True:
            raise AssertionError(f"{fixture['name']}: did not resolve")
        successes += 1
        if result.get("officialBlockFaceId") != fixture["expectedBlockFaceId"]:
            raise AssertionError(f"{fixture['name']}: identity mismatch")
        if not isinstance(result["officialBlockFaceId"], str):
            raise AssertionError(f"{fixture['name']}: identity was not a string")
        exact_matches += 1

    print(
        json.dumps(
            {
                "fixtures": len(fixtures),
                "successful": successes,
                "exactIdentityMatches": exact_matches,
                "safeRejections": safe_rejections,
            },
            separators=(",", ":"),
        )
    )


if __name__ == "__main__":
    try:
        main()
    except (AssertionError, KeyError, TypeError, URLError) as error:
        print(f"fixture verification failed: {error}", file=sys.stderr)
        raise SystemExit(1)
