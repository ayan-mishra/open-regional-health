from datetime import UTC, datetime

import pytest
from corvid.domain import QualityFlag
from corvid.ingestion.base import SourceSchemaError
from corvid.ingestion.nhsn import NhsnConnector

from tests.ingestion.conftest import load_json_fixture

RETRIEVED_AT = datetime(2026, 7, 25, 10, 32, 8, tzinfo=UTC)


def test_nhsn_marks_transition_and_voluntary_intervals() -> None:
    connector = NhsnConnector()
    rows = connector.parse_json(load_json_fixture("nhsn_ma.json"))
    records = connector.normalize(rows, retrieved_at=RETRIEVED_AT)
    primary = {
        record.observation_end: record
        for record in records
        if record.unit == "admissions"
    }

    first = primary[next(iter(sorted(primary)))]
    assert QualityFlag.REPORTING_REGIME_TRANSITION in first.quality_flags
    july = primary[[day for day in primary if day.isoformat() == "2024-07-06"][0]]
    assert QualityFlag.VOLUNTARY_REPORTING in july.quality_flags
    assert july.value == 0
    november = primary[[day for day in primary if day.isoformat() == "2024-11-02"][0]]
    assert QualityFlag.REPORTING_REGIME_TRANSITION in november.quality_flags
    assert november.metadata["primary_target_eligible"] is False


@pytest.mark.parametrize(
    ("coverage", "expected_flag"),
    [(None, QualityFlag.MISSING_COVERAGE), ("101", QualityFlag.INVALID_COVERAGE)],
)
def test_nhsn_retains_but_flags_missing_or_invalid_coverage(
    coverage: str | None, expected_flag: QualityFlag
) -> None:
    row = dict(load_json_fixture("nhsn_ma.json")[-1])
    if coverage is None:
        row.pop("totalconfflunewadmperchosprep")
    else:
        row["totalconfflunewadmperchosprep"] = coverage
    connector = NhsnConnector()
    record = connector.normalize(
        connector.parse_json([row]), retrieved_at=RETRIEVED_AT
    )[0]
    assert record.reporting_coverage is None
    assert expected_flag in record.quality_flags
    assert record.metadata["primary_target_eligible"] is False


def test_nhsn_accepts_legitimate_null_metric_row_without_dropping_batch() -> None:
    row = dict(load_json_fixture("nhsn_ma.json")[-1])
    row["totalconfflunewadm"] = None
    row["totalconfflunewadmper100k"] = None
    connector = NhsnConnector()

    parsed = connector.parse_json([row])

    assert connector.normalize(parsed, retrieved_at=RETRIEVED_AT) == []


@pytest.mark.parametrize(
    "field",
    [
        "totalconfflunewadm",
        "totalconfflunewadmper100k",
        "totalconfflunewadmhosprep",
        "numinptbeds",
        "numinptbedshosprep",
    ],
)
def test_nhsn_rejects_negative_counts_and_rates(field: str) -> None:
    row = dict(load_json_fixture("nhsn_ma.json")[-1])
    row[field] = "-1"

    with pytest.raises(SourceSchemaError, match="nonnegative"):
        NhsnConnector().parse_json([row])
