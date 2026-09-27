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
from corvid.ingestion.base import FetchResult, SourceSchemaError, require_object
from corvid.ingestion.client import SourceHttpClient
from corvid.normalization.geography import MASSACHUSETTS_GEOGRAPHIES
from corvid.normalization.observations import (
    mmwr_week_interval,
    parse_date,
    parse_int,
    parse_nonnegative_int,
    parse_percentage,
)


@dataclass(frozen=True, slots=True)
class FluViewRow:
    region: str
    epiweek: int
    issue: int
    release_date: date | None
    lag: int | None
    ili: float
    wili: float | None
    num_ili: int | None
    num_patients: int | None
    num_providers: int | None
    age_counts: tuple[int | None, ...]


class FluViewConnector:
    source_key = "fluview_ili"
    parser_version = "fluview-1"
    endpoint_url = "https://api.delphi.cmu.edu/epidata/fluview/"
    allowed_origins = frozenset({"https://api.delphi.cmu.edu"})
    source = SourceRecord(
        key=source_key,
        name="Delphi Epidata FluView",
        organization="Carnegie Mellon University Delphi Group / CDC",
        landing_page_url="https://cmu-delphi.github.io/delphi-epidata/api/fluview.html",
        endpoint_url=endpoint_url,
        update_cadence="weekly",
        license_name="Publicly Accessible US Government",
        allowed_use="research_and_commercial",
        revision_policy="issue-versioned",
    )
    geographies: tuple[GeographyRecord, ...] = (MASSACHUSETTS_GEOGRAPHIES[0],)

    def fetch(self, client: SourceHttpClient) -> FetchResult:
        return client.get(
            self.endpoint_url,
            params={"regions": "ma", "epiweeks": "202001-203053"},
        )

    def parse(self, snapshot: bytes) -> list[FluViewRow]:
        try:
            payload = json.loads(snapshot)
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            raise SourceSchemaError("FluView response is not valid JSON") from error
        return self.parse_json(payload)

    def parse_json(self, payload: object) -> list[FluViewRow]:
        root = require_object(payload, context="FluView response")
        result = root.get("result")
        if result == -2:
            return []
        epidata = root.get("epidata")
        if result != 1 or not isinstance(epidata, list):
            raise SourceSchemaError(
                "FluView response does not contain successful epidata"
            )
        rows: list[FluViewRow] = []
        for index, item in enumerate(epidata):
            row = require_object(item, context=f"FluView row {index}")
            region = row.get("region")
            if region != "ma":
                raise SourceSchemaError("FluView row is outside Massachusetts")
            release = row.get("release_date")
            rows.append(
                FluViewRow(
                    region=region,
                    epiweek=_required_int(row.get("epiweek"), "epiweek"),
                    issue=_required_int(row.get("issue"), "issue"),
                    release_date=(
                        parse_date(release, field="release_date")
                        if release is not None
                        else None
                    ),
                    lag=parse_int(row.get("lag"), field="lag"),
                    ili=_required_percentage(row.get("ili"), "ili"),
                    wili=parse_percentage(
                        row.get("wili"), field="wili", required=False
                    ),
                    num_ili=parse_nonnegative_int(
                        row.get("num_ili"), field="num_ili"
                    ),
                    num_patients=parse_nonnegative_int(
                        row.get("num_patients"), field="num_patients"
                    ),
                    num_providers=parse_nonnegative_int(
                        row.get("num_providers"), field="num_providers"
                    ),
                    age_counts=tuple(
                        parse_nonnegative_int(
                            row.get(f"num_age_{age}"), field=f"num_age_{age}"
                        )
                        for age in range(6)
                    ),
                )
            )
        return rows

    def normalize(
        self,
        records: list[FluViewRow],
        *,
        retrieved_at: datetime,
        raw_snapshot_id: int | None = None,
    ) -> list[ObservationRecord]:
        observations: list[ObservationRecord] = []
        for row in records:
            start, end = mmwr_week_interval(row.epiweek)
            flags = [QualityFlag.LIMITED_SENTINEL_COVERAGE]
            if row.release_date is None:
                flags.append(QualityFlag.MISSING_RELEASE_DATE)
            metadata = {
                "region": row.region,
                "epiweek": row.epiweek,
                "issue": row.issue,
                "lag": row.lag,
                "release_date": row.release_date.isoformat()
                if row.release_date
                else None,
                "release_date_missing": row.release_date is None,
                "num_ili": row.num_ili,
                "num_patients": row.num_patients,
                "num_providers": row.num_providers,
                **{f"num_age_{age}": count for age, count in enumerate(row.age_counts)},
                "source_documentation_url": self.source.landing_page_url,
                "limitation": "voluntary_sentinel_system",
            }
            for metric, value in (
                ("ili_percent", row.ili),
                ("weighted_ili_percent", row.wili),
            ):
                if value is None:
                    continue
                observations.append(
                    ObservationRecord(
                        source_key=self.source_key,
                        upstream_id=f"fluview:ma:{row.epiweek}:{row.issue}",
                        disease=Disease.INFLUENZA,
                        metric=metric,
                        value=value,
                        unit="percent_ili",
                        geography_id="ma",
                        observation_start=start,
                        observation_end=end,
                        issue_date=row.release_date,
                        issue_identity=f"issue:{row.issue}",
                        retrieved_at=retrieved_at,
                        raw_snapshot_id=raw_snapshot_id,
                        quality_flags=tuple(flags),
                        metadata=metadata,
                    )
                )
        return observations


def _required_int(value: object, field: str) -> int:
    parsed = parse_int(value, field=field, required=True)
    assert parsed is not None
    return parsed


def _required_percentage(value: object, field: str) -> float:
    parsed = parse_percentage(value, field=field)
    assert parsed is not None
    return parsed
