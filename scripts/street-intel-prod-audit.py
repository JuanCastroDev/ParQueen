#!/usr/bin/env python3
"""Privacy-safe production log aggregations for Street Intelligence 2A.31."""
import json
import subprocess
import sys
from collections import Counter

PROJECT = "parkqueen-46475363-ccf36"
SINCE = "2026-09-20T21:52:59Z"


GCLOUD = r"C:\Users\jayca\AppData\Local\Google\Cloud SDK\google-cloud-sdk\bin\gcloud.cmd"


def gcloud_read(filter_text, limit=5000):
    proc = subprocess.run(
        [
            GCLOUD, "logging", "read", filter_text,
            "--project", PROJECT,
            "--limit", str(limit),
            "--format=json",
            "--verbosity=error",
        ],
        capture_output=True,
        text=True,
        encoding="utf-8",
    )
    if proc.returncode != 0:
        return [], proc.stderr.strip()
    raw = proc.stdout.strip() or "[]"
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        return [], "json_decode_failed"
    return data if isinstance(data, list) else [], ""


def latency_ms(entry):
    lat = (entry.get("httpRequest") or {}).get("latency")
    if not lat:
        return None
    if isinstance(lat, str) and lat.endswith("s"):
        try:
            return float(lat[:-1]) * 1000
        except ValueError:
            return None
    return None


def percentiles(values):
    if not values:
        return None
    values = sorted(values)
    def pct(p):
        idx = min(len(values) - 1, max(0, int(round((p / 100) * (len(values) - 1)))))
        return round(values[idx], 1)
    return {"n": len(values), "p50_ms": pct(50), "p95_ms": pct(95), "max_ms": round(values[-1], 1)}


def summarize_http(entries):
    posts = [e for e in entries if (e.get("httpRequest") or {}).get("requestMethod") == "POST"]
    status = Counter()
    for e in posts:
        s = (e.get("httpRequest") or {}).get("status")
        if s is None:
            status["missing"] += 1
        elif 200 <= s < 300:
            status["2xx"] += 1
        elif 400 <= s < 500:
            status["4xx"] += 1
        elif 500 <= s < 600:
            status["5xx"] += 1
        else:
            status[str(s)] += 1
        if s is not None:
            status[f"status_{s}"] += 1
    lats = [latency_ms(e) for e in posts]
    lats = [v for v in lats if v is not None]
    return {
        "rows": len(entries),
        "posts": len(posts),
        "status": dict(status),
        "latency": percentiles(lats),
    }


def event_from_entry(entry):
    payload = entry.get("jsonPayload") or {}
    if isinstance(payload, dict):
        event = payload.get("event") or payload.get("message")
        if event:
            return str(event), payload
    text = entry.get("textPayload")
    if isinstance(text, str) and text.strip().startswith("{"):
        try:
            obj = json.loads(text)
            if isinstance(obj, dict):
                return str(obj.get("event") or obj.get("message") or "json_text"), obj
        except json.JSONDecodeError:
            pass
    return None, None


def summarize_events(entries):
    events = Counter()
    cohorts = Counter()
    outcomes = Counter()
    curb_states = Counter()
    domains = Counter()
    for e in entries:
        event, payload = event_from_entry(e)
        if not event:
            continue
        events[event] += 1
        if payload:
            if payload.get("cohort"):
                cohorts[str(payload["cohort"])] += 1
            if payload.get("outcome"):
                outcomes[str(payload["outcome"])] += 1
            if payload.get("curbState"):
                curb_states[str(payload["curbState"])] += 1
            if payload.get("domain"):
                domains[str(payload["domain"])] += 1
    return {
        "rows": len(entries),
        "events": dict(events),
        "cohorts": dict(cohorts),
        "outcomes": dict(outcomes),
        "curbStates": dict(curb_states),
        "domains": dict(domains),
        "severity": dict(Counter(e.get("severity") for e in entries)),
    }


def dump_callable_posts(entries):
    rows = []
    for e in entries:
        hr = e.get("httpRequest") or {}
        if hr.get("requestMethod") != "POST":
            continue
        rows.append({
            "ts": e.get("timestamp"),
            "status": hr.get("status"),
            "latency_ms": latency_ms(e),
        })
    return rows


def main():
    report = {"since": SINCE, "project": PROJECT}
    http_filter = (
        f'resource.labels.service_name="createsegmentfromsweepnyc" AND '
        f'logName="projects/{PROJECT}/logs/run.googleapis.com%2Frequests" AND '
        f'timestamp>="{SINCE}"'
    )
    http, err = gcloud_read(http_filter)
    report["callable_http"] = summarize_http(http)
    report["callable_http_error"] = err
    report["callable_post_timeline"] = dump_callable_posts(http)

    stdout_filter = (
        f'resource.labels.service_name="createsegmentfromsweepnyc" AND '
        f'logName="projects/{PROJECT}/logs/run.googleapis.com%2Fstdout" AND '
        f'timestamp>="{SINCE}"'
    )
    stdout, err2 = gcloud_read(stdout_filter)
    report["callable_stdout"] = summarize_events(stdout)
    report["callable_stdout_error"] = err2
    text_hits = Counter()
    for e in stdout:
        text = e.get("textPayload") or ""
        if not isinstance(text, str):
            continue
        for needle in (
            "curb_shadow_v1", "curb_product_skip", "cache_hit_", "dedup_hit_",
            "parser_attempted", "fallback_attempted", "meter_", "restriction_",
            "street_intel",
        ):
            if needle in text:
                text_hits[needle] += 1
    report["callable_stdout_text_needles"] = dict(text_hits)
    report["callable_stdout_sample_prefixes"] = [
        (e.get("textPayload") or "")[:80] for e in stdout[:12]
    ]

    stderr_filter = (
        f'resource.labels.service_name="createsegmentfromsweepnyc" AND '
        f'severity>=ERROR AND timestamp>="{SINCE}"'
    )
    errors, err3 = gcloud_read(stderr_filter, limit=2000)
    report["callable_error_plus"] = {
        "count": len(errors),
        "severities": dict(Counter(e.get("severity") for e in errors)),
        "error": err3,
    }

    resolver_http_filter = (
        f'resource.labels.service_name="parqueen-curb-resolver-spike" AND '
        f'logName="projects/{PROJECT}/logs/run.googleapis.com%2Frequests" AND '
        f'timestamp>="{SINCE}"'
    )
    resolver, err4 = gcloud_read(resolver_http_filter)
    statuses = Counter((e.get("httpRequest") or {}).get("status") for e in resolver)
    methods = Counter((e.get("httpRequest") or {}).get("requestMethod") for e in resolver)
    report["resolver_http"] = {
        "rows": len(resolver),
        "methods": dict(methods),
        "status": dict(statuses),
        "latency": percentiles([v for v in (latency_ms(e) for e in resolver) if v is not None]),
        "error": err4,
    }

    json_event_filter = (
        f'resource.labels.service_name="createsegmentfromsweepnyc" AND '
        f'timestamp>="{SINCE}" AND jsonPayload.event:*'
    )
    json_events, err5 = gcloud_read(json_event_filter)
    report["jsonPayload_event"] = summarize_events(json_events)
    report["jsonPayload_event_error"] = err5

    json.dump(report, sys.stdout, indent=2)
    print()


if __name__ == "__main__":
    main()
