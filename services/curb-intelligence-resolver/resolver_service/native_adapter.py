import ctypes
from dataclasses import dataclass
from pathlib import Path

from .contracts import LookupRequest


LIBGEO_PATH = Path("/geocode/version-26c_26.3/lib/libgeo.so")
WA1_SIZE = 1200
WA2_SIZE = 1000

# Release-specific 26C offsets. These are not a universal Geosupport ABI.
FUNCTION_SLICE = slice(0, 2)
BOROUGH_SLICES = (slice(56, 57), slice(99, 100), slice(142, 143))
STREET_SLICES = (slice(67, 99), slice(110, 142), slice(153, 185))
COMPASS_SLICE = slice(203, 204)
WORK_AREA_FORMAT_SLICE = slice(212, 213)
CROSS_STREET_NAMES_FLAG_SLICE = slice(322, 323)
MODE_SWITCH_SLICE = slice(329, 330)
NORMALIZED_STREET_SLICES = (slice(407, 439), slice(450, 482), slice(493, 525))
REASON_CODE_SLICE = slice(712, 713)
GRC_SLICE = slice(716, 718)
BFI_SLICE = slice(529, 539)


class NativeContractError(RuntimeError):
    """The pinned native boundary returned structurally invalid data."""


@dataclass(frozen=True)
class NativeResult:
    return_code: str
    reason_code: str
    block_face_id: str | None
    normalized_street_names: tuple[str, str, str]


class Geosupport26CAdapter:
    ready = True

    def __init__(self, library=None):
        self._library = library if library is not None else ctypes.CDLL(str(LIBGEO_PATH))
        self._geo = self._library.geo
        self._geo.argtypes = [ctypes.POINTER(ctypes.c_char), ctypes.POINTER(ctypes.c_char)]
        self._geo.restype = None

    def lookup(self, request: LookupRequest) -> NativeResult:
        wa1 = ctypes.create_string_buffer(WA1_SIZE)
        wa2 = ctypes.create_string_buffer(WA2_SIZE)
        wa1.raw = b" " * WA1_SIZE
        wa2.raw = b" " * WA2_SIZE

        self._set(wa1, FUNCTION_SLICE, "3C")
        streets = (request.on_street, request.cross_street_one, request.cross_street_two)
        for borough_slice, street_slice, street in zip(
            BOROUGH_SLICES, STREET_SLICES, streets
        ):
            self._set(wa1, borough_slice, request.borough_code)
            self._set(wa1, street_slice, street)
        self._set(wa1, COMPASS_SLICE, request.compass_direction)
        self._set(wa1, WORK_AREA_FORMAT_SLICE, "C")
        self._set(wa1, CROSS_STREET_NAMES_FLAG_SLICE, "E")
        self._set(wa1, MODE_SWITCH_SLICE, "X")

        wa1_pointer = ctypes.cast(wa1, ctypes.POINTER(ctypes.c_char))
        wa2_pointer = ctypes.cast(wa2, ctypes.POINTER(ctypes.c_char))
        self._geo(wa1_pointer, wa2_pointer)

        if self._decode(wa1, FUNCTION_SLICE) != "3C":
            raise NativeContractError("function code changed")

        return_code = self._decode(wa1, GRC_SLICE)
        reason_code = self._decode(wa1, REASON_CODE_SLICE)
        if return_code != "00":
            return NativeResult(return_code, reason_code, None, ("", "", ""))

        normalized_names = tuple(
            self._decode(wa1, target).rstrip() for target in NORMALIZED_STREET_SLICES
        )
        block_face_id = self._decode(wa2, BFI_SLICE).strip()
        return NativeResult(
            return_code,
            reason_code,
            block_face_id,
            normalized_names,
        )

    @staticmethod
    def _set(buffer, target: slice, value: str) -> None:
        encoded = value.encode("ascii")
        width = target.stop - target.start
        if len(encoded) > width:
            raise NativeContractError("input field exceeds reviewed native width")
        buffer[target] = encoded.ljust(width, b" ")

    @staticmethod
    def _decode(buffer, target: slice) -> str:
        try:
            return bytes(buffer[target]).decode("ascii")
        except UnicodeDecodeError as error:
            raise NativeContractError("non-ASCII native output") from error
