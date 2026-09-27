import json
from dataclasses import dataclass
from datetime import date, datetime, timedelta

from corvid.domain import (
    Disease,
    GeographyRecord,
    ObservationRecord,
    QualityFlag,
    SourceRecord,
)
from corvid.domain.types import JsonObject
from corvid.ingestion.base import FetchResult, SourceSchemaError, require_object
from corvid.ingestion.client import SourceHttpClient
from corvid.normalization.geography import MASSACHUSETTS_GEOGRAPHIES
from corvid.normalization.observations import (
    parse_date,
    parse_nonnegative_float,
    parse_percentage,
)

_DISEASES = {
    "RSV": Disease.RSV,
    "SARS-COV-2": Disease.COVID_19,
}


@dataclass(frozen=True, slots=True)
class NrevssRow:
    week_ending: date
    state: str
    pathogen: str
    posted: date
    tests_3wma: float | None
    detections_5wma: float | None
    percent_positive_3wma: float | None
    tests_suppressed: bool
    detections_suppressed: bool
    positivity_suppressed: bool
    source_row: JsonObject


class NrevssConnector:
    source_key = "nrevss_naat"
    parser_version = "nrevss-naat-1"
    endpoint_url = "https://data.cdc.gov/resource/rgnm-fkqb.json"
    allowed_origins = frozenset({"https://data.cdc.gov"})
    request_parameters: dict[str, str | int] = {
        "$select": (
            "mmwrweek_end,level,state,pathogen,posted,tests_3wma,"
            "detections_5wma,percent_pos_3wma"
        ),
        "$where": (
            "level='State' AND state='MA' "
            "AND pathogen IN('RSV','SARS-COV-2')"
        ),
        "$order": "mmwrweek_end ASC,pathogen ASC",
        "$limit": 50000,
    }
    source = SourceRecord(
        key=source_key,
        name="NREVSS Respiratory Virus NAAT Percent Positivity",
        organization="Centers for Disease Control and Prevention",
        landing_page_url="https://data.cdc.gov/d/rgnm-fkqb",
        endpoint_url=endpoint_url,
        update_cadence="weekly",
        license_name="Public Domain U.S. Government",
        allowed_use="research_and_commercial",
        known_delay="most recent week is less complete than prior weeks",
        revision_policy="posted-date issues; rows may be revised for up to two years",
    )
    geographies: tuple[GeographyRecord, ...] = (MASSACHUSETTS_GEOGRAPHIES[0],)

    def fetch(self, client: SourceHttpClient) -> FetchResult:
        return client.get(self.endpoint_url, params=self.request_parameters)

    def parse(self, snapshot: bytes) -> list[NrevssRow]:
        try:
            payload = json.loads(snapshot)
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            raise SourceSchemaError("NREVSS response is not valid JSON") from error
        return self.parse_json(payload)

    def parse_json(self, payload: object) -> list[NrevssRow]:
        if not isinstance(payload, list):
            raise SourceSchemaError("NREVSS response must be a JSON array")
        records: list[NrevssRow] = []
        for index, item in enumerate(payload):
            row = require_object(item, context=f"NREVSS row {index}")
            if row.get("level") != "State":
                raise SourceSchemaError("NREVSS row is not state-level")
            state = row.get("state")
            if state != "MA":
                raise SourceSchemaError("NREVSS row is outside Massachusetts")
            pathogen = row.get("pathogen")
            if not isinstance(pathogen, str) or pathogen not in _DISEASES:
                raise SourceSchemaError("NREVSS state pathogen is unsupported")
            week_ending = parse_date(
                row.get("mmwrweek_end"), field="mmwrweek_end"
            )
            if week_ending.weekday() != 5:
                raise SourceSchemaError("mmwrweek_end must be a Saturday")
            posted = parse_date(row.get("posted"), field="posted")
            if posted < week_ending:
                raise SourceSchemaError("posted must not precede mmwrweek_end")
            tests, tests_suppressed = _suppressed_nonnegative_float(
                row.get("tests_3wma"), field="tests_3wma"
            )
            detections, detections_suppressed = _suppressed_nonnegative_float(
                row.get("detections_5wma"), field="detections_5wma"
            )
            positivity, positivity_suppressed = _suppressed_percentage(
                row.get("percent_pos_3wma"), field="percent_pos_3wma"
            )
            records.append(
                NrevssRow(
                    week_ending=week_ending,
                    state=state,
                    pathogen=pathogen,
                    posted=posted,
                    tests_3wma=tests,
                    detections_5wma=detections,
                    percent_positive_3wma=positivity,
                    tests_suppressed=tests_suppressed,
                    detections_suppressed=detections_suppressed,
                    positivity_suppressed=positivity_suppressed,
                    source_row=dict(row),
                )
            )
        return records

    def normalize(
        self,
        records: list[NrevssRow],
        *,
        retrieved_at: datetime,
        raw_snapshot_id: int | None = None,
    ) -> list[ObservationRecord]:
        if not records:
            return []
        latest_week_by_pathogen: dict[str, date] = {}
        for row in records:
            prior = latest_week_by_pathogen.get(row.pathogen)
            if prior is None or row.week_ending > prior:
                latest_week_by_pathogen[row.pathogen] = row.week_ending
        observations: list[ObservationRecord] = []
        for row in records:
            if row.percent_positive_3wma is None:
                continue
            flags = [QualityFlag.LIMITED_SENTINEL_COVERAGE]
            if (
                row.tests_suppressed
                or row.detections_suppressed
                or row.positivity_suppressed
            ):
                flags.append(QualityFlag.SPARSE)
            observations.append(
                ObservationRecord(
                    source_key=self.source_key,
                    upstream_id=(
                        f"nrevss:MA:{row.pathogen}:{row.week_ending.isoformat()}"
                    ),
                    disease=_DISEASES[row.pathogen],
                    metric="naat_percent_positive_3wma",
                    value=row.percent_positive_3wma,
                    unit="percent_positive_naat",
                    geography_id="ma",
                    observation_start=row.week_ending - timedelta(days=6),
                    observation_end=row.week_ending,
                    issue_date=row.posted,
                    issue_identity=f"posted:{row.posted.isoformat()}",
                    revision=row.posted.isoformat(),
                    retrieved_at=retrieved_at,
                    raw_snapshot_id=raw_snapshot_id,
                    quality_flags=tuple(flags),
                    metadata={
                        "level": "State",
                        "state": row.state,
                        "pathogen": row.pathogen,
                        "posted": row.posted.isoformat(),
                        "tests_3wma": row.tests_3wma,
                        "detections_5wma": row.detections_5wma,
                        "tests_suppressed": row.tests_suppressed,
                        "detections_suppressed": row.detections_suppressed,
                        "positivity_suppressed": row.positivity_suppressed,
                        "centered_window": "previous,current,following weeks",
                        "latest_week_uses_partial_centered_window": (
                            row.week_ending == latest_week_by_pathogen[row.pathogen]
                        ),
                        "provisional": True,
                        "voluntary_reporting": True,
                        "source_row": row.source_row,
                    },
                )
            )
        return observations


def _suppressed_nonnegative_float(
    value: object, *, field: str
) -> tuple[float | None, bool]:
    if value == "*":
        return None, True
    if value is None or value == "" or value == ".":
        return None, False
    return parse_nonnegative_float(value, field=field), False


def _suppressed_percentage(
    value: object, *, field: str
) -> tuple[float | None, bool]:
    if value == "*":
        return None, True
    if value is None or value == "" or value == ".":
        return None, False
    return parse_percentage(value, field=field), False
