import pytest

from resolver_service.app import create_app
from resolver_service.native_adapter import NativeResult
from resolver_service.service import ResolverService


VALID_REQUEST = {
    "borough": "MANHATTAN",
    "onStreet": "GOLD STREET",
    "crossStreetOne": "BEEKMAN STREET",
    "crossStreetTwo": "ANN STREET",
    "compassDirection": "W",
}


class RecordingAdapter:
    ready = True

    def __init__(self, result=None, error=None):
        self.calls = []
        self.result = result or NativeResult(
            return_code="00",
            reason_code=" ",
            block_face_id="0212261301",
            normalized_street_names=("GOLD STREET", "BEEKMAN STREET", "ANN STREET"),
        )
        self.error = error

    def lookup(self, request):
        self.calls.append(request)
        if self.error:
            raise self.error
        return self.result


def make_client(adapter=None):
    adapter = adapter or RecordingAdapter()
    app = create_app(ResolverService(adapter))
    app.config.update(TESTING=True)
    return app.test_client(), adapter


def test_valid_request_maps_borough_and_returns_string_identity():
    client, adapter = make_client()

    response = client.post("/resolve-blockface", json=VALID_REQUEST)

    assert response.status_code == 200
    assert response.get_json() == {
        "ok": True,
        "officialBlockFaceId": "0212261301",
        "normalizedStreetNames": {
            "onStreet": "GOLD STREET",
            "crossStreetOne": "BEEKMAN STREET",
            "crossStreetTwo": "ANN STREET",
        },
        "returnCode": "00",
        "reasonCode": " ",
        "sourceVersion": {
            "geosupportRelease": "26C",
            "geosupportVersion": "26.3",
        },
    }
    assert adapter.calls[0].borough_code == "1"


@pytest.mark.parametrize(
    "borough,code",
    [
        ("MANHATTAN", "1"),
        ("BRONX", "2"),
        ("BROOKLYN", "3"),
        ("QUEENS", "4"),
        ("STATEN ISLAND", "5"),
    ],
)
def test_canonical_borough_mapping(borough, code):
    client, adapter = make_client()
    payload = {**VALID_REQUEST, "borough": borough}

    assert client.post("/resolve-blockface", json=payload).status_code == 200

    assert adapter.calls[0].borough_code == code


@pytest.mark.parametrize(
    "payload",
    [
        None,
        [],
        {},
        {**VALID_REQUEST, "extra": "no"},
        {**VALID_REQUEST, "lat": 40.7},
        {**VALID_REQUEST, "lng": -74.0},
        {**VALID_REQUEST, "userId": "forbidden"},
        {**VALID_REQUEST, "officialBlockFaceId": "0212261301"},
        {key: value for key, value in VALID_REQUEST.items() if key != "onStreet"},
        {**VALID_REQUEST, "borough": "manhattan"},
        {**VALID_REQUEST, "borough": "RICHMOND"},
        {**VALID_REQUEST, "onStreet": ""},
        {**VALID_REQUEST, "onStreet": "   "},
        {**VALID_REQUEST, "onStreet": "CAFÉ STREET"},
        {**VALID_REQUEST, "onStreet": "A" * 33},
        {**VALID_REQUEST, "onStreet": 7},
        {**VALID_REQUEST, "compassDirection": "NW"},
        {**VALID_REQUEST, "compassDirection": "w"},
    ],
)
def test_invalid_requests_are_rejected_without_native_call(payload):
    client, adapter = make_client()

    if payload is None:
        response = client.post(
            "/resolve-blockface", data="not-json", content_type="text/plain"
        )
    else:
        response = client.post("/resolve-blockface", json=payload)

    assert response.status_code == 400
    assert response.get_json() == {"ok": False, "failureClass": "INVALID_REQUEST"}
    assert adapter.calls == []


def test_health_is_compact_and_does_not_call_native_lookup():
    client, adapter = make_client()

    response = client.get("/healthz")

    assert response.status_code == 200
    assert response.get_json() == {
        "ok": True,
        "sourceVersion": {
            "geosupportRelease": "26C",
            "geosupportVersion": "26.3",
        },
    }
    assert adapter.calls == []


def test_oversized_body_is_rejected_without_native_call():
    client, adapter = make_client()

    response = client.post(
        "/resolve-blockface",
        data=b"{" + (b"x" * 5000) + b"}",
        content_type="application/json",
    )

    assert response.status_code == 400
    assert response.get_json() == {"ok": False, "failureClass": "INVALID_REQUEST"}
    assert adapter.calls == []


def test_success_uses_normalized_native_names_not_request_echo():
    adapter = RecordingAdapter(
        NativeResult(
            return_code="00",
            reason_code=" ",
            block_face_id="0212261301",
            normalized_street_names=("GOLD ST", "BEEKMAN ST", "ANN ST"),
        )
    )
    client, _ = make_client(adapter)

    response = client.post("/resolve-blockface", json=VALID_REQUEST)

    assert response.get_json()["normalizedStreetNames"] == {
        "onStreet": "GOLD ST",
        "crossStreetOne": "BEEKMAN ST",
        "crossStreetTwo": "ANN ST",
    }
