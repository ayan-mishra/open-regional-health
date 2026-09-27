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
    parse_float,
    parse_nonnegative_float,
)


@dataclass(frozen=True, slots=True)
class NhsnRow:
    week_ending: date
    jurisdiction: str
    admissions: float | None
    admissions_per_100k: float | None
    reporting_hospitals: float | None
    reporting_percent: float | None
    inpatient_beds: float | None
    inpatient_bed_reporting_hospitals: float | None
    inpatient_bed_reporting_percent: float | None
    respiratory_season: str | None
    source_row: JsonObject


class NhsnConnector:
    source_key = "nhsn_hospital"
    parser_version = "nhsn-1"
    endpoint_url = "https://data.cdc.gov/resource/ua7e-t2fy.json"
    allowed_origins = frozenset({"https://data.cdc.gov"})
    request_parameters: dict[str, str | int] = {
        "$select": (
            "weekendingdate,jurisdiction,totalconfflunewadm,"
            "totalconfflunewadmper100k,totalconfflunewadmhosprep,"
            "totalconfflunewadmperchosprep,numinptbeds,"
            "numinptbedshosprep,numinptbedsperchosprep,respseason"
        ),
        "$where": "jurisdiction='MA'",
        "$order": "weekendingdate ASC",
        "$limit": 50000,
    }
    source = SourceRecord(
        key=source_key,
        name="Weekly Hospital Respiratory Data by Jurisdiction",
        organization="Centers for Disease Control and Prevention",
        landing_page_url="https://data.cdc.gov/d/ua7e-t2fy",
        endpoint_url=endpoint_url,
        update_cadence="weekly",
        license_name="Public Domain U.S. Government",
        allowed_use="research_and_commercial",
        revision_policy="in-place upstream revisions retained by raw snapshot",
    )
    geographies: tuple[GeographyRecord, ...] = (MASSACHUSETTS_GEOGRAPHIES[0],)

    def fetch(self, client: SourceHttpClient) -> FetchResult:
        return client.get(self.endpoint_url, params=self.request_parameters)

    def parse(self, snapshot: bytes) -> list[NhsnRow]:
        try:
            payload = json.loads(snapshot)
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            raise SourceSchemaError("NHSN response is not valid JSON") from error
        return self.parse_json(payload)

    def parse_json(self, payload: object) -> list[NhsnRow]:
        if not isinstance(payload, list):
            raise SourceSchemaError("NHSN response must be a JSON array")
        records: list[NhsnRow] = []
        for index, item in enumerate(payload):
            row = require_object(item, context=f"NHSN row {index}")
            jurisdiction = row.get("jurisdiction")
            if jurisdiction != "MA":
                raise SourceSchemaError("NHSN row is outside Massachusetts")
            season = row.get("respseason")
            if season is not None and not isinstance(season, str):
                raise SourceSchemaError("respseason must be text when present")
            records.append(
                NhsnRow(
                    week_ending=parse_date(
                        row.get("weekendingdate"), field="weekendingdate"
                    ),
                    jurisdiction=jurisdiction,
                    admissions=parse_nonnegative_float(
                        row.get("totalconfflunewadm"),
                        field="totalconfflunewadm",
                        required=False,
                    ),
                    admissions_per_100k=parse_nonnegative_float(
                        row.get("totalconfflunewadmper100k"),
                        field="totalconfflunewadmper100k",
                        required=False,
                    ),
                    reporting_hospitals=parse_nonnegative_float(
                        row.get("totalconfflunewadmhosprep"),
                        field="totalconfflunewadmhosprep",
                        required=False,
                    ),
                    reporting_percent=parse_float(
                        row.get("totalconfflunewadmperchosprep"),
                        field="totalconfflunewadmperchosprep",
                        required=False,
                    ),
                    inpatient_beds=parse_nonnegative_float(
                        row.get("numinptbeds"), field="numinptbeds", required=False
                    ),
                    inpatient_bed_reporting_hospitals=parse_nonnegative_float(
                        row.get("numinptbedshosprep"),
                        field="numinptbedshosprep",
                        required=False,
                    ),
                    inpatient_bed_reporting_percent=parse_float(
                        row.get("numinptbedsperchosprep"),
                        field="numinptbedsperchosprep",
                        required=False,
                    ),
                    respiratory_season=season,
                    source_row=dict(row),
                )
            )
        return records

    def normalize(
        self,
        records: list[NhsnRow],
        *,
        retrieved_at: datetime,
        raw_snapshot_id: int | None = None,
    ) -> list[ObservationRecord]:
        observations: list[ObservationRecord] = []
        for row in records:
            start = row.week_ending - timedelta(days=6)
            flags: list[QualityFlag] = []
            eligible = True
            coverage: float | None = None
            if row.reporting_percent is None:
                flags.append(QualityFlag.MISSING_COVERAGE)
                eligible = False
            elif not 0 <= row.reporting_percent <= 100:
                flags.append(QualityFlag.INVALID_COVERAGE)
                eligible = False
            else:
                coverage = row.reporting_percent / 100
            if _is_transition_week(start, row.week_ending):
                flags.append(QualityFlag.REPORTING_REGIME_TRANSITION)
                eligible = False
            elif date(2024, 5, 1) <= start and row.week_ending <= date(2024, 10, 31):
                flags.append(QualityFlag.VOLUNTARY_REPORTING)
            metadata = {
                "jurisdiction": row.jurisdiction,
                "reporting_hospitals": row.reporting_hospitals,
                "reporting_percent_source": row.reporting_percent,
                "inpatient_beds": row.inpatient_beds,
                "inpatient_bed_reporting_hospitals": (
                    row.inpatient_bed_reporting_hospitals
                ),
                "inpatient_bed_reporting_percent": (
                    row.inpatient_bed_reporting_percent
                ),
                "respiratory_season": row.respiratory_season,
                "primary_target_eligible": eligible,
                "source_row": row.source_row,
            }
            for metric, value, unit in (
                ("confirmed_influenza_admissions", row.admissions, "admissions"),
                (
                    "confirmed_influenza_admissions_per_100k",
                    row.admissions_per_100k,
                    "admissions_per_100k",
                ),
            ):
                if value is None:
                    continue
                observations.append(
                    ObservationRecord(
                        source_key=self.source_key,
                        upstream_id=f"nhsn:MA:{row.week_ending.isoformat()}",
                        disease=Disease.INFLUENZA,
                        metric=metric,
                        value=value,
                        unit=unit,
                        geography_id="ma",
                        observation_start=start,
                        observation_end=row.week_ending,
                        issue_date=None,
                        issue_identity=(
                            f"snapshot:{raw_snapshot_id}"
                            if raw_snapshot_id is not None
                            else f"retrieved:{retrieved_at.isoformat()}"
                        ),
                        revision=retrieved_at.isoformat(),
                        retrieved_at=retrieved_at,
                        raw_snapshot_id=raw_snapshot_id,
                        quality_flags=tuple(flags),
                        reporting_coverage=coverage,
                        metadata=metadata,
                    )
                )
        return observations


def _is_transition_week(start: date, end: date) -> bool:
    return (start <= date(2024, 5, 1) <= end) or (
        start <= date(2024, 11, 1) <= end
    )
