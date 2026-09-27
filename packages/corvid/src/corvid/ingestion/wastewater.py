import hashlib
import json
from dataclasses import dataclass
from datetime import date, datetime

from corvid.domain import (
    Disease,
    GeographyRecord,
    ObservationRecord,
    QualityFlag,
    SourceRecord,
)
from corvid.domain.types import JsonObject
from corvid.ingestion.base import (
    FetchResult,
    SourceSchemaError,
    SourceValidationError,
    require_object,
)
from corvid.ingestion.client import SourceHttpClient
from corvid.ingestion.source_policies import IngestionMode, SourcePolicy
from corvid.normalization.geography import MASSACHUSETTS_GEOGRAPHIES
from corvid.normalization.observations import parse_date, parse_nonnegative_float


@dataclass(frozen=True, slots=True)
class WastewaterRow:
    record_id: str
    site: str | None
    state_territory: str
    source: str | None
    sample_collect_date: date
    concentration: float
    concentration_unit: str
    detected: str | None
    source_row: JsonObject


class WastewaterConnector:
    source_key = "nwss_influenza_a"
    parser_version = "nwss-influenza-a-1"
    endpoint_url = "https://data.cdc.gov/resource/ymmh-divb.json"
    allowed_origins = frozenset({"https://data.cdc.gov"})
    request_parameters: dict[str, str | int] = {
        "$where": "state_territory='ma'",
        "$order": "sample_collect_date ASC,record_id ASC",
        "$limit": 50000,
    }
    source = SourceRecord(
        key=source_key,
        name="CDC Wastewater Data for Influenza A",
        organization="Centers for Disease Control and Prevention",
        landing_page_url="https://data.cdc.gov/d/ymmh-divb",
        endpoint_url=endpoint_url,
        update_cadence="weekly",
        license_name="Public Domain U.S. Government",
        allowed_use="research_and_commercial",
        revision_policy="record identity with update metadata",
    )
    geographies: tuple[GeographyRecord, ...] = (MASSACHUSETTS_GEOGRAPHIES[0],)

    def __init__(self, *, mode: IngestionMode = "research") -> None:
        self.mode = mode

    def fetch(self, client: SourceHttpClient) -> FetchResult:
        return client.get(self.endpoint_url, params=self.request_parameters)

    def parse(self, snapshot: bytes) -> list[WastewaterRow]:
        try:
            payload = json.loads(snapshot)
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            raise SourceSchemaError("wastewater response is not valid JSON") from error
        return self.parse_json(payload)

    def parse_json(self, payload: object) -> list[WastewaterRow]:
        if not isinstance(payload, list):
            raise SourceSchemaError("wastewater response must be a JSON array")
        records: list[WastewaterRow] = []
        for index, item in enumerate(payload):
            row = require_object(item, context=f"wastewater row {index}")
            state = _required_string(row.get("state_territory"), "state_territory")
            if state != "ma":
                raise SourceSchemaError("wastewater row is outside Massachusetts")
            records.append(
                WastewaterRow(
                    record_id=_required_string(row.get("record_id"), "record_id"),
                    site=_optional_string(row.get("site"), "site"),
                    state_territory=state,
                    source=_optional_string(row.get("source"), "source"),
                    sample_collect_date=parse_date(
                        row.get("sample_collect_date"), field="sample_collect_date"
                    ),
                    concentration=_required_nonnegative_float(
                        row.get("pcr_target_avg_conc"), "pcr_target_avg_conc"
                    ),
                    concentration_unit=_required_string(
                        row.get("pcr_target_units"), "pcr_target_units"
                    ),
                    detected=_optional_string(
                        row.get("pcr_target_detect"), "pcr_target_detect"
                    ),
                    source_row=dict(row),
                )
            )
        return records

    def normalize(
        self,
        records: list[WastewaterRow],
        *,
        retrieved_at: datetime,
        raw_snapshot_id: int | None = None,
    ) -> list[ObservationRecord]:
        if not SourcePolicy.for_source(self.source_key).is_allowed(self.mode):
            raise SourceValidationError(
                f"{self.source_key} is not allowed in {self.mode} mode"
            )
        observations: list[ObservationRecord] = []
        for row in records:
            non_detect = row.detected is not None and row.detected.lower() == "no"
            compatibility_key = _compatibility_key(row.source_row)
            metadata = dict(row.source_row)
            metadata.update(
                {
                    "detected": not non_detect,
                    "non_detect": non_detect,
                    "compatibility_key": compatibility_key,
                    "raw_aggregation_eligible": False,
                    "source_documentation_url": self.source.landing_page_url,
                }
            )
            flags = [QualityFlag.EXPERIMENTAL]
            if non_detect:
                flags.append(QualityFlag.NON_DETECT)
            observations.append(
                ObservationRecord(
                    source_key=self.source_key,
                    upstream_id=f"nwss:{row.record_id}",
                    disease=Disease.INFLUENZA,
                    metric="influenza_a_pcr_target_average_concentration",
                    value=row.concentration,
                    unit=row.concentration_unit,
                    geography_id="ma",
                    observation_start=row.sample_collect_date,
                    observation_end=row.sample_collect_date,
                    issue_date=None,
                    issue_identity=f"record:{row.record_id}",
                    retrieved_at=retrieved_at,
                    raw_snapshot_id=raw_snapshot_id,
                    quality_flags=tuple(flags),
                    metadata=metadata,
                )
            )
        return observations


def _compatibility_key(row: JsonObject) -> str:
    fields = (
        "pcr_target_units",
        "sample_matrix",
        "concentration_method",
        "pcr_type",
        "extraction_method",
        "pcr_target",
        "pcr_gene_target_agg",
        "site",
        "source",
    )
    canonical = json.dumps([row.get(field) for field in fields], separators=(",", ":"))
    return hashlib.sha256(canonical.encode()).hexdigest()


def _required_string(value: object, field: str) -> str:
    if not isinstance(value, str) or not value:
        raise SourceSchemaError(f"{field} must be a non-empty string")
    return value


def _optional_string(value: object, field: str) -> str | None:
    if value is None:
        return None
    if not isinstance(value, str):
        raise SourceSchemaError(f"{field} must be text when present")
    return value


def _required_nonnegative_float(value: object, field: str) -> float:
    parsed = parse_nonnegative_float(value, field=field)
    assert parsed is not None
    return parsed
