import re
import threading
from dataclasses import dataclass
from typing import Any

from . import PROVIDER_RELEASE, PROVIDER_VERSION
from .contracts import ValidationError, parse_lookup_request
from .native_adapter import NativeContractError


RETURN_CODE_PATTERN = re.compile(r"^[A-Z0-9 ]{2}$")
REASON_CODE_PATTERN = re.compile(r"^[A-Z0-9 ]$")
BLOCK_FACE_ID_PATTERN = re.compile(r"^[0-9]{10}$")


@dataclass(frozen=True)
class ServiceResult:
    payload: dict[str, Any]
    status_code: int
    outcome: str
    return_code: str = "NA"


class ResolverService:
    def __init__(self, adapter):
        self.adapter = adapter
        self._native_lock = threading.Lock()

    @property
    def ready(self) -> bool:
        return bool(getattr(self.adapter, "ready", False))

    def resolve_payload(self, payload: Any) -> ServiceResult:
        request = parse_lookup_request(payload)
        try:
            with self._native_lock:
                native_result = self.adapter.lookup(request)
        except NativeContractError:
            return self._failure("NATIVE_CONTRACT_FAILURE", 503, "native_contract_failure")
        except Exception:
            return self._failure("NATIVE_UNAVAILABLE", 503, "native_unavailable")

        if not RETURN_CODE_PATTERN.fullmatch(native_result.return_code):
            return self._failure("NATIVE_CONTRACT_FAILURE", 503, "native_contract_failure")
        if not REASON_CODE_PATTERN.fullmatch(native_result.reason_code):
            return self._failure("NATIVE_CONTRACT_FAILURE", 503, "native_contract_failure")

        if native_result.return_code != "00":
            return ServiceResult(
                payload={
                    "ok": False,
                    "returnCode": native_result.return_code,
                    "reasonCode": native_result.reason_code,
                    "failureClass": "NOT_AUTHORITATIVE",
                },
                status_code=200,
                outcome="not_authoritative",
                return_code=native_result.return_code,
            )

        if not native_result.block_face_id or not BLOCK_FACE_ID_PATTERN.fullmatch(
            native_result.block_face_id
        ):
            return self._failure("NATIVE_CONTRACT_FAILURE", 503, "native_contract_failure")
        if not self._valid_normalized_names(native_result.normalized_street_names):
            return self._failure("NATIVE_CONTRACT_FAILURE", 503, "native_contract_failure")

        on_street, cross_one, cross_two = native_result.normalized_street_names
        return ServiceResult(
            payload={
                "ok": True,
                "officialBlockFaceId": native_result.block_face_id,
                "normalizedStreetNames": {
                    "onStreet": on_street,
                    "crossStreetOne": cross_one,
                    "crossStreetTwo": cross_two,
                },
                "returnCode": native_result.return_code,
                "reasonCode": native_result.reason_code,
                "sourceVersion": {
                    "geosupportRelease": PROVIDER_RELEASE,
                    "geosupportVersion": PROVIDER_VERSION,
                },
            },
            status_code=200,
            outcome="authoritative",
            return_code="00",
        )

    @staticmethod
    def _valid_normalized_names(names) -> bool:
        if not isinstance(names, tuple) or len(names) != 3:
            return False
        for name in names:
            if not isinstance(name, str) or not name or len(name) > 32:
                return False
            try:
                name.encode("ascii")
            except UnicodeEncodeError:
                return False
        return True

    @staticmethod
    def _failure(failure_class: str, status_code: int, outcome: str) -> ServiceResult:
        return ServiceResult(
            payload={"ok": False, "failureClass": failure_class},
            status_code=status_code,
            outcome=outcome,
        )


__all__ = ["ResolverService", "ServiceResult", "ValidationError"]
