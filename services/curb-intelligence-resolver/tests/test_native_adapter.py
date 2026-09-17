import ctypes

import pytest

from resolver_service.contracts import LookupRequest
from resolver_service.native_adapter import (
    BFI_SLICE,
    BOROUGH_SLICES,
    COMPASS_SLICE,
    FUNCTION_SLICE,
    GRC_SLICE,
    NORMALIZED_STREET_SLICES,
    STREET_SLICES,
    Geosupport26CAdapter,
    NativeContractError,
)


REQUEST = LookupRequest(
    borough_code="1",
    on_street="GOLD STREET",
    cross_street_one="BEEKMAN STREET",
    cross_street_two="ANN STREET",
    compass_direction="W",
)


class FakeLibrary:
    def __init__(self, mutate):
        self.mutate = mutate
        self.seen_wa1 = None
        self.seen_wa2 = None

        def geo(wa1, wa2):
            self.seen_wa1 = bytearray(ctypes.string_at(wa1, 1200))
            self.seen_wa2 = bytearray(ctypes.string_at(wa2, 1000))
            self.mutate(wa1, wa2)

        self.geo = geo


def write(pointer, target_slice, value):
    ctypes.memmove(
        ctypes.addressof(pointer.contents) + target_slice.start,
        value,
        len(value),
    )


def test_builds_reviewed_mutable_function_3c_work_areas():
    def respond(wa1, wa2):
        write(wa1, GRC_SLICE, b"01")

    library = FakeLibrary(respond)
    adapter = Geosupport26CAdapter(library=library)

    result = adapter.lookup(REQUEST)

    assert library.seen_wa1[FUNCTION_SLICE] == b"3C"
    assert [library.seen_wa1[item] for item in BOROUGH_SLICES] == [b"1", b"1", b"1"]
    assert [library.seen_wa1[item].rstrip() for item in STREET_SLICES] == [
        b"GOLD STREET",
        b"BEEKMAN STREET",
        b"ANN STREET",
    ]
    assert library.seen_wa1[COMPASS_SLICE] == b"W"
    assert len(library.seen_wa1) == 1200
    assert len(library.seen_wa2) == 1000
    assert result.return_code == "01"


def test_grc_00_reads_identity_and_normalized_names_as_strings():
    def respond(wa1, wa2):
        write(wa1, GRC_SLICE, b"00")
        for target, value in zip(
            NORMALIZED_STREET_SLICES,
            (b"GOLD STREET", b"BEEKMAN STREET", b"ANN STREET"),
        ):
            write(wa1, target, value)
        write(wa2, BFI_SLICE, b"0212261301")

    result = Geosupport26CAdapter(library=FakeLibrary(respond)).lookup(REQUEST)

    assert result.return_code == "00"
    assert result.block_face_id == "0212261301"
    assert result.normalized_street_names == (
        "GOLD STREET",
        "BEEKMAN STREET",
        "ANN STREET",
    )
    assert isinstance(result.block_face_id, str)


def test_nonzero_grc_does_not_parse_identity_looking_output():
    def respond(wa1, wa2):
        write(wa1, GRC_SLICE, b"01")
        write(wa2, BFI_SLICE, b"\xff" * 10)

    result = Geosupport26CAdapter(library=FakeLibrary(respond)).lookup(REQUEST)

    assert result.return_code == "01"
    assert result.block_face_id is None
    assert result.normalized_street_names == ("", "", "")


def test_rejects_native_mutation_of_function_code():
    def respond(wa1, wa2):
        write(wa1, FUNCTION_SLICE, b"1B")
        write(wa1, GRC_SLICE, b"00")

    with pytest.raises(NativeContractError):
        Geosupport26CAdapter(library=FakeLibrary(respond)).lookup(REQUEST)
