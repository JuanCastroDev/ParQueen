import threading
import time

import pytest

from resolver_service.app import create_app
from resolver_service.native_adapter import NativeContractError, NativeResult
from resolver_service.service import ResolverService

from test_http_contract import RecordingAdapter, VALID_REQUEST


@pytest.mark.parametrize("return_code", ["01", "02", "EE", "  "])
def test_nonzero_return_code_is_fail_closed_and_discards_stale_identity(return_code):
    adapter = RecordingAdapter(
        NativeResult(
            return_code=return_code,
            reason_code="7",
            block_face_id="9999999999",
            normalized_street_names=("SECRET ONE", "SECRET TWO", "SECRET THREE"),
        )
    )
    app = create_app(ResolverService(adapter))
    app.config.update(TESTING=True)

    response = app.test_client().post("/resolve-blockface", json=VALID_REQUEST)

    assert response.status_code == 200
    assert response.get_json() == {
        "ok": False,
        "returnCode": return_code,
        "reasonCode": "7",
        "failureClass": "NOT_AUTHORITATIVE",
    }
    assert "officialBlockFaceId" not in response.get_data(as_text=True)
    assert "9999999999" not in response.get_data(as_text=True)
    assert "SECRET" not in response.get_data(as_text=True)


@pytest.mark.parametrize(
    "block_face_id",
    [None, "", "123", "ABCDEFGHIJ", "12345678901", "0000000000", 212261301],
)
def test_grc_00_rejects_malformed_or_all_zero_identity(block_face_id):
    adapter = RecordingAdapter(
        NativeResult(
            return_code="00",
            reason_code=" ",
            block_face_id=block_face_id,
            normalized_street_names=("ONE", "TWO", "THREE"),
        )
    )
    app = create_app(ResolverService(adapter))
    app.config.update(TESTING=True)

    response = app.test_client().post("/resolve-blockface", json=VALID_REQUEST)

    assert response.status_code == 503
    assert response.get_json() == {
        "ok": False,
        "failureClass": "NATIVE_CONTRACT_FAILURE",
    }
    assert "officialBlockFaceId" not in response.get_data(as_text=True)


@pytest.mark.parametrize(
    "normalized_name",
    [
        "GOLD\x00STREET",
        "GOLD\nSTREET",
        "GOLD\rSTREET",
        "GOLD\tSTREET",
        "GOLD\x7fSTREET",
    ],
)
def test_grc_00_rejects_control_characters_in_normalized_names(normalized_name):
    adapter = RecordingAdapter(
        NativeResult(
            return_code="00",
            reason_code=" ",
            block_face_id="0212261301",
            normalized_street_names=(normalized_name, "TWO", "THREE"),
        )
    )
    app = create_app(ResolverService(adapter))
    app.config.update(TESTING=True)

    response = app.test_client().post("/resolve-blockface", json=VALID_REQUEST)

    assert response.status_code == 503
    assert response.get_json() == {
        "ok": False,
        "failureClass": "NATIVE_CONTRACT_FAILURE",
    }
    assert "officialBlockFaceId" not in response.get_data(as_text=True)


def test_native_exception_is_sanitized():
    adapter = RecordingAdapter(error=RuntimeError("native secret address data"))
    app = create_app(ResolverService(adapter))
    app.config.update(TESTING=True)

    response = app.test_client().post("/resolve-blockface", json=VALID_REQUEST)

    assert response.status_code == 503
    assert response.get_json() == {
        "ok": False,
        "failureClass": "NATIVE_UNAVAILABLE",
    }
    assert "secret" not in response.get_data(as_text=True)


def test_native_contract_exception_is_distinguished_but_sanitized():
    adapter = RecordingAdapter(error=NativeContractError("raw provider output"))
    app = create_app(ResolverService(adapter))
    app.config.update(TESTING=True)

    response = app.test_client().post("/resolve-blockface", json=VALID_REQUEST)

    assert response.status_code == 503
    assert response.get_json() == {
        "ok": False,
        "failureClass": "NATIVE_CONTRACT_FAILURE",
    }
    assert "provider output" not in response.get_data(as_text=True)


def test_service_serializes_native_calls():
    class BlockingAdapter:
        ready = True

        def __init__(self):
            self.active = 0
            self.maximum_active = 0
            self.guard = threading.Lock()

        def lookup(self, request):
            with self.guard:
                self.active += 1
                self.maximum_active = max(self.maximum_active, self.active)
            time.sleep(0.04)
            with self.guard:
                self.active -= 1
            return NativeResult("01", "7", None, ("", "", ""))

    adapter = BlockingAdapter()
    service = ResolverService(adapter)
    barrier = threading.Barrier(3)

    def resolve():
        barrier.wait()
        service.resolve_payload(VALID_REQUEST)

    threads = [threading.Thread(target=resolve) for _ in range(2)]
    for thread in threads:
        thread.start()
    barrier.wait()
    for thread in threads:
        thread.join()

    assert adapter.maximum_active == 1


def test_one_request_makes_one_native_attempt():
    adapter = RecordingAdapter()
    service = ResolverService(adapter)

    service.resolve_payload(VALID_REQUEST)

    assert len(adapter.calls) == 1
