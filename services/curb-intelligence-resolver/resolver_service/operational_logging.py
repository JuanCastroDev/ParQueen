import json
import logging

from . import SERVICE_VERSION


LOGGER = logging.getLogger("curb_intelligence_resolver")


def configure_for_gunicorn() -> None:
    gunicorn_logger = logging.getLogger("gunicorn.error")
    LOGGER.handlers = list(gunicorn_logger.handlers)
    LOGGER.setLevel(logging.INFO)
    LOGGER.propagate = False


def log_lookup(outcome: str, return_code: str, latency_ms: int) -> None:
    LOGGER.info(
        json.dumps(
            {
                "event": "lookup_complete",
                "outcome": outcome,
                "returnCode": return_code,
                "latencyMs": latency_ms,
                "serviceVersion": SERVICE_VERSION,
            },
            separators=(",", ":"),
            sort_keys=True,
        )
    )
