import json
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import date, datetime, timedelta

from corvid.domain import (
    Disease,
    ObservationRecord,
    QualityFlag,
    SourceRecord,
    UpstreamTrajectory,
)
from corvid.ingestion.base import FetchResult, SourceSchemaError, require_object
from corvid.ingestion.client import SourceHttpClient
from corvid.normalization.geography import (
    MASSACHUSETTS_GEOGRAPHIES,
    resolve_nssp_geography,
)
from corvid.normalization.observations import parse_date, parse_percentage


@dataclass(frozen=True, slots=True)
class NsspRow:
    week_end: date
    geography: str
    county: str
    hsa: str
    hsa_counties: str
    hsa_nci_id: str
    fips: str
    percent_visits: dict[Disease, float | None]
    percent_visits_smoothed: dict[Disease, float | None]
    upstream_trends: dict[Disease, str | None]
    trend_source: str
    build_number: str


class NsspConnector:
    source_key = "nssp_ed"
    parser_version = "nssp-1"
    endpoint_url = "https://data.cdc.gov/resource/rdmq-nq56.json"
    allowed_origins = frozenset({"https://data.cdc.gov"})
    request_parameters: dict[str, str | int] = {
        "$select": (
            "week_end,geography,county,hsa,hsa_counties,hsa_nci_id,fips,"
            "percent_visits_covid,percent_visits_influenza,percent_visits_rsv,"
            "percent_visits_smoothed_covid,percent_visits_smoothed_1,"
            "percent_visits_smoothed_rsv,ed_trends_covid,"
            "ed_trends_influenza,ed_trends_rsv,trend_source,buildnumber"
        ),
        "$where": "geography='Massachusetts'",
        "$order": "week_end ASC,trend_source ASC,hsa_nci_id ASC,county ASC",
        "$limit": 50000,
    }
    source = SourceRecord(
        key=source_key,
        name="NSSP Emergency Department Visit Trajectories",
        organization="Centers for Disease Control and Prevention",
        landing_page_url="https://data.cdc.gov/d/rdmq-nq56",
        endpoint_url=endpoint_url,
        update_cadence="weekly",
        license_name="Public Domain U.S. Government",
        allowed_use="research_and_commercial",
        revision_policy="in-place upstream revisions retained by raw snapshot",
    )
    geographies = MASSACHUSETTS_GEOGRAPHIES

    def fetch(self, client: SourceHttpClient) -> FetchResult:
        return client.get(self.endpoint_url, params=self.request_parameters)

    def parse(self, snapshot: bytes) -> list[NsspRow]:
        try:
            payload = json.loads(snapshot)
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            raise SourceSchemaError("NSSP response is not valid JSON") from error
        return self.parse_json(payload)

    def parse_json(self, payload: object) -> list[NsspRow]:
        if not isinstance(payload, list):
            raise SourceSchemaError("NSSP response must be a JSON array")
        rows: list[NsspRow] = []
        for index, item in enumerate(payload):
            row = require_object(item, context=f"NSSP row {index}")
            rows.append(
                NsspRow(
                    week_end=parse_date(row.get("week_end"), field="week_end"),
                    geography=_required_string(row, "geography"),
                    county=_required_string(row, "county"),
                    hsa=_required_string(row, "hsa"),
                    hsa_counties=_required_string(row, "hsa_counties"),
                    hsa_nci_id=_required_string(row, "hsa_nci_id"),
                    fips=_required_string(row, "fips"),
                    percent_visits={
                        Disease.INFLUENZA: parse_percentage(
                            row.get("percent_visits_influenza"),
                            field="percent_visits_influenza",
                            required=False,
                        ),
                        Disease.COVID_19: parse_percentage(
                            row.get("percent_visits_covid"),
                            field="percent_visits_covid",
                            required=False,
                        ),
                        Disease.RSV: parse_percentage(
                            row.get("percent_visits_rsv"),
                            field="percent_visits_rsv",
                            required=False,
                        ),
                    },
                    percent_visits_smoothed={
                        Disease.INFLUENZA: parse_percentage(
                            row.get("percent_visits_smoothed_1"),
                            field="percent_visits_smoothed_1",
                            required=False,
                        ),
                        Disease.COVID_19: parse_percentage(
                            row.get("percent_visits_smoothed_covid"),
                            field="percent_visits_smoothed_covid",
                            required=False,
                        ),
                        Disease.RSV: parse_percentage(
                            row.get("percent_visits_smoothed_rsv"),
                            field="percent_visits_smoothed_rsv",
                            required=False,
                        ),
                    },
                    upstream_trends={
                        Disease.INFLUENZA: _optional_string(
                            row.get("ed_trends_influenza"), "ed_trends_influenza"
                        ),
                        Disease.COVID_19: _optional_string(
                            row.get("ed_trends_covid"), "ed_trends_covid"
                        ),
                        Disease.RSV: _optional_string(
                            row.get("ed_trends_rsv"), "ed_trends_rsv"
                        ),
                    },
                    trend_source=_required_string(row, "trend_source"),
                    build_number=_required_string(row, "buildnumber"),
                )
            )
        return rows

    def normalize(
        self,
        records: list[NsspRow],
        *,
        retrieved_at: datetime,
        raw_snapshot_id: int | None = None,
    ) -> list[ObservationRecord]:
        deduplicated: dict[tuple[date, str, str], NsspRow] = {}
        for row in records:
            if row.geography != "Massachusetts":
                raise SourceSchemaError("NSSP row is outside Massachusetts")
            geography_id = resolve_nssp_geography(
                trend_source=row.trend_source,
                hsa_nci_id=row.hsa_nci_id,
                fips=row.fips,
            )
            key = (row.week_end, geography_id, row.build_number)
            existing = deduplicated.get(key)
            if existing is not None:
                if _deduplication_payload(existing) != _deduplication_payload(row):
                    raise SourceSchemaError(
                        f"conflicting duplicate NSSP HSA row for {geography_id}"
                    )
                continue
            deduplicated[key] = row

        observations: list[ObservationRecord] = []
        for (week_end, geography_id, build_number), row in deduplicated.items():
            for disease in Disease:
                source_trajectory = row.upstream_trends[disease]
                trajectory = _normalize_trajectory(source_trajectory)
                metrics = (
                    ("ed_visit_percent", row.percent_visits[disease]),
                    (
                        "ed_visit_percent_smoothed",
                        row.percent_visits_smoothed[disease],
                    ),
                )
                for metric, value in metrics:
                    if value is None:
                        continue
                    is_hsa = geography_id != "ma"
                    observations.append(
                        ObservationRecord(
                        source_key=self.source_key,
                        upstream_id=(
                            f"nssp:{disease.value}:{row.trend_source}:"
                            f"{row.hsa_nci_id}:{week_end}"
                        ),
                        disease=disease,
                        metric=metric,
                        value=value,
                        unit="percentage_points",
                        geography_id=geography_id,
                        observation_start=week_end - timedelta(days=6),
                        observation_end=week_end,
                        issue_date=None,
                        issue_identity=(
                            f"build:{build_number}#retrieved:{retrieved_at.isoformat()}"
                        ),
                        retrieved_at=retrieved_at,
                        raw_snapshot_id=raw_snapshot_id,
                        revision=build_number,
                        quality_flags=(QualityFlag.EXPERIMENTAL,) if is_hsa else (),
                        metadata={
                            "geography": row.geography,
                            "county": row.county,
                            "hsa": row.hsa,
                            "hsa_counties": row.hsa_counties,
                            "hsa_nci_id": row.hsa_nci_id,
                            "fips": row.fips,
                            "upstream_trajectory": trajectory.value,
                            "upstream_trajectory_source": source_trajectory,
                            "trend_source": row.trend_source,
                            "buildnumber": row.build_number,
                        },
                    )
                )
        return observations


def _required_string(row: Mapping[str, object], field: str) -> str:
    value = row.get(field)
    if not isinstance(value, str) or not value:
        raise SourceSchemaError(f"{field} must be a non-empty string")
    return value


def _optional_string(value: object, field: str) -> str | None:
    if value is None:
        return None
    if not isinstance(value, str):
        raise SourceSchemaError(f"{field} must be text when present")
    return value


def _normalize_trajectory(value: str | None) -> UpstreamTrajectory:
    if value is None:
        return UpstreamTrajectory.UNAVAILABLE
    normalized = " ".join(value.strip().lower().replace("_", " ").split())
    return {
        "increasing": UpstreamTrajectory.RISING,
        "rising": UpstreamTrajectory.RISING,
        "no change": UpstreamTrajectory.STABLE,
        "stable": UpstreamTrajectory.STABLE,
        "decreasing": UpstreamTrajectory.FALLING,
        "falling": UpstreamTrajectory.FALLING,
        "sparse": UpstreamTrajectory.SPARSE,
        "insufficient data": UpstreamTrajectory.INSUFFICIENT_DATA,
        "not enough data": UpstreamTrajectory.INSUFFICIENT_DATA,
        "no data": UpstreamTrajectory.UNAVAILABLE,
        "unavailable": UpstreamTrajectory.UNAVAILABLE,
    }.get(normalized, UpstreamTrajectory.UNKNOWN)


def _deduplication_payload(row: NsspRow) -> tuple[object, ...]:
    return (
        row.hsa,
        row.hsa_counties,
        row.hsa_nci_id,
        tuple(row.percent_visits.items()),
        tuple(row.percent_visits_smoothed.items()),
        tuple(row.upstream_trends.items()),
        row.trend_source,
        row.build_number,
    )
