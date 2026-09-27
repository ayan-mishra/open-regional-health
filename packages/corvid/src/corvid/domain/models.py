import re
from dataclasses import dataclass, field
from datetime import UTC, date, datetime
from math import isfinite
from typing import Any

from corvid.domain.enums import (
    Direction,
    Disease,
    GeographyType,
    IngestionStatus,
    QualityFlag,
)
from corvid.domain.types import JsonObject, freeze_json_object


def _require_aware(value: datetime, field_name: str) -> None:
    if value.tzinfo is None or value.utcoffset() is None:
        raise ValueError(f"{field_name} must be timezone-aware")


@dataclass(frozen=True, slots=True)
class SourceRecord:


    key: str
    name: str
    organization: str
    landing_page_url: str
    endpoint_url: str | None = None
    update_cadence: str | None = None
    license_name: str | None = None
    allowed_use: str | None = None
    known_delay: str | None = None
    revision_policy: str | None = None


@dataclass(frozen=True, slots=True)
class GeographyRecord:


    id: str
    geography_type: GeographyType
    display_name: str
    state_code: str
    upstream_identifiers: JsonObject = field(default_factory=dict)
    member_counties: tuple[str, ...] = ()
    experimental: bool = False

    def __post_init__(self) -> None:
        object.__setattr__(
            self, "upstream_identifiers", freeze_json_object(self.upstream_identifiers)
        )


@dataclass(frozen=True, slots=True)
class ObservationRecord:


    source_key: str
    upstream_id: str
    disease: Disease
    metric: str
    value: float
    unit: str
    geography_id: str
    observation_start: date
    observation_end: date
    issue_date: date | None
    retrieved_at: datetime
    raw_snapshot_id: int | None = None
    issue_identity: str | None = None
    revision: str | None = None
    quality_flags: tuple[QualityFlag, ...] = ()
    reporting_coverage: float | None = None
    metadata: JsonObject = field(default_factory=dict)

    def __post_init__(self) -> None:
        _require_aware(self.retrieved_at, "retrieved_at")
        object.__setattr__(self, "retrieved_at", self.retrieved_at.astimezone(UTC))
        object.__setattr__(self, "metadata", freeze_json_object(self.metadata))
        if not isfinite(self.value):
            raise ValueError("value must be finite")
        if self.observation_end < self.observation_start:
            raise ValueError("observation_end must not precede observation_start")
        if (
            self.reporting_coverage is not None
            and not 0 <= self.reporting_coverage <= 1
        ):
            raise ValueError("reporting_coverage must be between 0 and 1")

    @property
    def canonical_issue_identity(self) -> str:


        if self.issue_identity is not None:
            return self.issue_identity
        issue = (
            self.issue_date.isoformat() if self.issue_date is not None else "initial"
        )
        if self.revision is None:
            return issue
        return f"{issue}#revision:{self.revision}"


@dataclass(frozen=True, slots=True)
class ForecastRecord:


    geography_id: str
    target_start: date
    target_end: date
    direction: Direction
    confidence: float
    point_estimate: float | None = None
    evidence_observation_ids: tuple[int, ...] = ()
    source_availability: JsonObject = field(default_factory=dict)
    metadata: JsonObject = field(default_factory=dict)

    def __post_init__(self) -> None:
        object.__setattr__(
            self,
            "source_availability",
            freeze_json_object(self.source_availability),
        )
        object.__setattr__(self, "metadata", freeze_json_object(self.metadata))
        if self.target_end < self.target_start:
            raise ValueError("target_end must not precede target_start")
        if not isfinite(self.confidence) or not 0 <= self.confidence <= 1:
            raise ValueError("confidence must be between 0 and 1")
        if self.point_estimate is not None and not isfinite(self.point_estimate):
            raise ValueError("point_estimate must be finite")


@dataclass(frozen=True, slots=True)
class RawSnapshotRecord:


    source_key: str
    retrieved_at: datetime
    request_url: str
    sha256: str
    blob_path: str
    parser_version: str
    status: IngestionStatus
    request_parameters: JsonObject = field(default_factory=dict)
    response_headers: JsonObject = field(default_factory=dict)
    http_status: int | None = None
    error_message: str | None = None

    def __post_init__(self) -> None:
        _require_aware(self.retrieved_at, "retrieved_at")
        object.__setattr__(self, "retrieved_at", self.retrieved_at.astimezone(UTC))
        object.__setattr__(
            self,
            "request_parameters",
            freeze_json_object(self.request_parameters),
        )
        object.__setattr__(
            self, "response_headers", freeze_json_object(self.response_headers)
        )
        if re.fullmatch(r"[0-9a-f]{64}", self.sha256) is None:
            raise ValueError("sha256 must be a lowercase hexadecimal SHA-256 digest")


def enum_values(values: tuple[Any, ...]) -> list[str]:


    return [str(value) for value in values]
