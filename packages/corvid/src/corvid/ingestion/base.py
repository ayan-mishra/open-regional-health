from collections.abc import Mapping
from dataclasses import dataclass, field
from datetime import datetime
from typing import TYPE_CHECKING, Any, Protocol, cast

from corvid.domain import GeographyRecord, ObservationRecord, SourceRecord
from corvid.domain.types import JsonObject

if TYPE_CHECKING:
    from corvid.ingestion.client import SourceHttpClient


class IngestionError(RuntimeError):
    pass


class SourceTransportError(IngestionError):
    pass


class SourceSchemaError(IngestionError):
    pass


class SourceValidationError(IngestionError):
    pass


@dataclass(frozen=True, slots=True)
class FetchResult:


    content: bytes
    retrieved_at: datetime
    request_url: str
    http_status: int
    request_parameters: JsonObject = field(default_factory=dict)
    response_headers: JsonObject = field(default_factory=dict)


class Connector(Protocol):


    source_key: str
    parser_version: str
    allowed_origins: frozenset[str]
    source: SourceRecord
    geographies: tuple[GeographyRecord, ...]

    def fetch(self, client: "SourceHttpClient") -> FetchResult: ...

    def parse(self, snapshot: bytes) -> list[Any]: ...

    def normalize(
        self,
        records: list[Any],
        *,
        retrieved_at: datetime,
        raw_snapshot_id: int | None = None,
    ) -> list[ObservationRecord]: ...


def require_object(value: object, *, context: str) -> JsonObject:
    if not isinstance(value, Mapping) or not all(
        isinstance(key, str) for key in value
    ):
        raise SourceSchemaError(f"{context} must be a JSON object")
    return cast(JsonObject, value)
