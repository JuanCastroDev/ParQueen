from dataclasses import dataclass
from typing import Any


BOROUGH_CODES = {
    "MANHATTAN": "1",
    "BRONX": "2",
    "BROOKLYN": "3",
    "QUEENS": "4",
    "STATEN ISLAND": "5",
}
EXPECTED_FIELDS = frozenset(
    {
        "borough",
        "onStreet",
        "crossStreetOne",
        "crossStreetTwo",
        "compassDirection",
    }
)
STREET_FIELDS = ("onStreet", "crossStreetOne", "crossStreetTwo")
STREET_BYTE_LIMIT = 32
COMPASS_DIRECTIONS = frozenset({"N", "S", "E", "W"})


class ValidationError(ValueError):
    """The request does not satisfy the closed resolver contract."""


@dataclass(frozen=True)
class LookupRequest:
    borough_code: str
    on_street: str
    cross_street_one: str
    cross_street_two: str
    compass_direction: str


def parse_lookup_request(payload: Any) -> LookupRequest:
    if not isinstance(payload, dict) or set(payload) != EXPECTED_FIELDS:
        raise ValidationError("request shape")

    borough = payload["borough"]
    if not isinstance(borough, str) or borough not in BOROUGH_CODES:
        raise ValidationError("borough")

    streets = []
    for field in STREET_FIELDS:
        value = payload[field]
        if not isinstance(value, str):
            raise ValidationError("street type")
        if not value or value != value.strip():
            raise ValidationError("street empty or padded")
        try:
            encoded = value.encode("ascii")
        except UnicodeEncodeError as error:
            raise ValidationError("street encoding") from error
        if any(byte < 0x20 or byte > 0x7E for byte in encoded):
            raise ValidationError("street characters")
        if len(encoded) > STREET_BYTE_LIMIT:
            raise ValidationError("street length")
        streets.append(value)

    compass = payload["compassDirection"]
    if not isinstance(compass, str) or compass not in COMPASS_DIRECTIONS:
        raise ValidationError("compass")

    return LookupRequest(
        borough_code=BOROUGH_CODES[borough],
        on_street=streets[0],
        cross_street_one=streets[1],
        cross_street_two=streets[2],
        compass_direction=compass,
    )
