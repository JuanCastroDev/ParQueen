import time

from flask import Flask, jsonify, request

from . import PROVIDER_RELEASE, PROVIDER_VERSION
from .contracts import ValidationError
from .operational_logging import log_lookup


def create_app(resolver_service) -> Flask:
    app = Flask(__name__)
    app.config["MAX_CONTENT_LENGTH"] = 4096

    @app.errorhandler(413)
    def request_too_large(_error):
        log_lookup("invalid_request", "NA", 0)
        return jsonify({"ok": False, "failureClass": "INVALID_REQUEST"}), 400

    @app.get("/healthz")
    def health():
        ready = resolver_service.ready
        return (
            jsonify(
                {
                    "ok": ready,
                    "sourceVersion": {
                        "geosupportRelease": PROVIDER_RELEASE,
                        "geosupportVersion": PROVIDER_VERSION,
                    },
                }
            ),
            200 if ready else 503,
        )

    @app.post("/resolve-blockface")
    def resolve_blockface():
        started = time.monotonic()
        payload = request.get_json(silent=True) if request.is_json else None
        try:
            result = resolver_service.resolve_payload(payload)
        except ValidationError:
            result_payload = {"ok": False, "failureClass": "INVALID_REQUEST"}
            status_code = 400
            outcome = "invalid_request"
            return_code = "NA"
        else:
            result_payload = result.payload
            status_code = result.status_code
            outcome = result.outcome
            return_code = result.return_code

        elapsed_ms = max(0, round((time.monotonic() - started) * 1000))
        log_lookup(outcome, return_code, elapsed_ms)
        return jsonify(result_payload), status_code

    return app
