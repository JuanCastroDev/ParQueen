import logging

from resolver_service.app import create_app
from resolver_service.native_adapter import NativeResult
from resolver_service.service import ResolverService

from test_http_contract import RecordingAdapter, VALID_REQUEST


def test_operational_log_excludes_request_identity_and_native_message(caplog):
    adapter = RecordingAdapter(
        NativeResult(
            return_code="01",
            reason_code="7",
            block_face_id="9999999999",
            normalized_street_names=("GOLD STREET", "BEEKMAN STREET", "ANN STREET"),
        )
    )
    app = create_app(ResolverService(adapter))
    app.config.update(TESTING=True)

    with caplog.at_level(logging.INFO, logger="curb_intelligence_resolver"):
        app.test_client().post("/resolve-blockface", json=VALID_REQUEST)

    log_text = caplog.text
    assert "lookup_complete" in log_text
    assert "not_authoritative" in log_text
    for forbidden in (
        "GOLD STREET",
        "BEEKMAN STREET",
        "ANN STREET",
        "MANHATTAN",
        "9999999999",
    ):
        assert forbidden not in log_text


def test_native_exception_text_is_not_logged(caplog):
    adapter = RecordingAdapter(error=RuntimeError("GOLD STREET exploded"))
    app = create_app(ResolverService(adapter))
    app.config.update(TESTING=True)

    with caplog.at_level(logging.INFO, logger="curb_intelligence_resolver"):
        app.test_client().post("/resolve-blockface", json=VALID_REQUEST)

    assert "native_unavailable" in caplog.text
    assert "GOLD STREET" not in caplog.text
    assert "exploded" not in caplog.text
