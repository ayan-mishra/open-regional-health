from __future__ import annotations

import csv
import json
from dataclasses import dataclass
from datetime import UTC, date, datetime, time, timedelta
from pathlib import Path
from typing import Any, cast

from corvid.domain import Disease, GeographyType, ObservationRecord, QualityFlag
from corvid.domain.models import GeographyRecord, SourceRecord
from corvid.services.assessment import TARGET_METRIC, TARGET_SOURCE_KEY
from corvid.services.pipeline import publish_database_forecasts, run_database_backtests
from corvid.storage import Database, UnitOfWork


@dataclass(frozen=True, slots=True)
class DemoLoadSummary:
    inserted_observations: int
    inserted_backtests: int
    published_assessments: int
    as_of: datetime
    disclaimer: str


def load_demo_data(
    database: Database,
    *,
    data_dir: Path,
    fixture_dir: Path,
) -> DemoLoadSummary:


    manifest = _read_manifest(fixture_dir / "manifest.json")
    as_of = _parse_utc(str(manifest["as_of"]))
    rows = _read_weekly_rows(
        fixture_dir / str(manifest["data_file"]),
        expected_rows=int(manifest["row_count"]),
    )
    source = SourceRecord(
        key=TARGET_SOURCE_KEY,
        name="CDC NSSP (demonstration fixture)",
        organization="Centers for Disease Control and Prevention",
        landing_page_url="https://www.cdc.gov/nssp/",
        update_cadence="fixed offline demonstration fixture",
        license_name="Public Domain U.S. Government",
        allowed_use="demonstration only",
        known_delay="Synthetic publication vintages; not current surveillance",
        revision_policy="immutable fixture version",
    )
    geographies = (
        GeographyRecord(
            id="ma",
            geography_type=GeographyType.STATE,
            display_name="Massachusetts",
            state_code="MA",
            upstream_identifiers={"fixture_key": "ma"},
        ),
        GeographyRecord(
            id="ma-hsa-22",
            geography_type=GeographyType.HSA,
            display_name="Middlesex / Suffolk (Boston)",
            state_code="MA",
            upstream_identifiers={"fixture_key": "ma-hsa-22"},
            experimental=True,
        ),
    )
    observations: list[ObservationRecord] = []
    fixture_version = str(manifest["fixture_version"])
    for week_end, statewide, hsa in rows:
        retrieved_at = datetime.combine(
            week_end + timedelta(days=4), time(12, 0), tzinfo=UTC
        )
        for geography_id, value, coverage, flags in (
            ("ma", statewide, 0.96, ()),
            ("ma-hsa-22", hsa, 0.78, (QualityFlag.EXPERIMENTAL,)),
        ):
            observations.append(
                ObservationRecord(
                    source_key=TARGET_SOURCE_KEY,
                    upstream_id=f"demo:{geography_id}:{week_end.isoformat()}",
                    disease=Disease.INFLUENZA,
                    metric=TARGET_METRIC,
                    value=value,
                    unit="percentage_points",
                    geography_id=geography_id,
                    observation_start=week_end - timedelta(days=6),
                    observation_end=week_end,
                    issue_date=None,
                    issue_identity=f"{fixture_version}:{week_end.isoformat()}",
                    retrieved_at=retrieved_at,
                    quality_flags=flags,
                    reporting_coverage=coverage,
                    metadata={
                        "vintage_kind": "synthetic_demo",
                        "authentic_vintage": False,
                        "synthetic": True,
                        "fixture_version": fixture_version,
                        "demonstration": True,
                    },
                )
            )

    with UnitOfWork(database) as work:
        work.sources.upsert_source(source)
        for geography in geographies:
            work.geographies.upsert_geography(geography)
        inserted = work.observations.insert_observations(observations)

    backtests = run_database_backtests(
        database,
        geography_ids=("ma", "ma-hsa-22"),
        source_key=TARGET_SOURCE_KEY,
        metric=TARGET_METRIC,
        as_of=as_of,
    )
    published = publish_database_forecasts(
        database,
        source_key=TARGET_SOURCE_KEY,
        metric=TARGET_METRIC,
        mode="demo",
        as_of=as_of,
    )
    data_dir.mkdir(parents=True, exist_ok=True)
    metadata = {
        "mode": "demo",
        "fixture_version": fixture_version,
        "as_of": as_of.isoformat(),
        "disclaimer": manifest["disclaimer"],
        "source_manifest": "data/demo/manifest.json",
        "vintage_kind": "synthetic_demo",
        "authentic_vintage": False,
    }
    (data_dir / "demo-metadata.json").write_text(
        json.dumps(metadata, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )
    return DemoLoadSummary(
        inserted_observations=inserted,
        inserted_backtests=backtests,
        published_assessments=published,
        as_of=as_of,
        disclaimer=str(manifest["disclaimer"]),
    )


def _read_manifest(path: Path) -> dict[str, Any]:
    raw = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(raw, dict):
        raise ValueError("demo manifest must be a JSON object")
    required = {
        "schema_version",
        "fixture_version",
        "mode",
        "as_of",
        "data_file",
        "row_count",
        "disclaimer",
    }
    if not required.issubset(raw) or raw.get("mode") != "demo":
        raise ValueError("demo manifest is incomplete or not labeled demo")
    if raw.get("schema_version") != "1.0":
        raise ValueError("unsupported demo manifest schema")
    return cast(dict[str, Any], raw)


def _read_weekly_rows(
    path: Path, *, expected_rows: int
) -> tuple[tuple[date, float, float], ...]:
    rows: list[tuple[date, float, float]] = []
    with path.open(encoding="utf-8", newline="") as handle:
        reader = csv.DictReader(handle)
        if reader.fieldnames != ["week_end", "ma", "ma_hsa_22"]:
            raise ValueError("demo CSV columns do not match the reviewed schema")
        for item in reader:
            week_end = date.fromisoformat(item["week_end"])
            if week_end.weekday() != 5:
                raise ValueError("demo observations must end on Saturday")
            rows.append((week_end, float(item["ma"]), float(item["ma_hsa_22"])))
    if len(rows) != expected_rows or len(rows) < 104:
        raise ValueError("demo CSV must contain the declared multi-season history")
    pairs = zip(rows, rows[1:], strict=False)
    if any(right[0] - left[0] != timedelta(days=7) for left, right in pairs):
        raise ValueError("demo CSV weekly history must be contiguous")
    return tuple(rows)


def _parse_utc(value: str) -> datetime:
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        raise ValueError("demo as_of must be timezone-aware")
    return parsed.astimezone(UTC)
