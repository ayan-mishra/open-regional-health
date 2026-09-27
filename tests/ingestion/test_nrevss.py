from datetime import UTC, date, datetime

import pytest
from corvid.domain import Disease, QualityFlag
from corvid.ingestion.base import SourceSchemaError
from corvid.ingestion.nrevss import NrevssConnector

from tests.ingestion.conftest import load_json_fixture

RETRIEVED_AT = datetime(2026, 8, 1, 12, tzinfo=UTC)


def test_nrevss_preserves_posted_vintage_and_suppression() -> None:
    connector = NrevssConnector()
    records = connector.normalize(
        connector.parse_json(load_json_fixture("nrevss_ma.json")),
        retrieved_at=RETRIEVED_AT,
        raw_snapshot_id=41,
    )

    assert len(records) == 4
    assert {record.disease for record in records} == {
        Disease.COVID_19,
        Disease.RSV,
    }
    assert {record.issue_date for record in records} == {date(2026, 7, 31)}
    assert {record.issue_identity for record in records} == {"posted:2026-07-31"}
    assert {record.metric for record in records} == {
        "naat_percent_positive_3wma"
    }
    assert all(
        QualityFlag.LIMITED_SENTINEL_COVERAGE in record.quality_flags
        for record in records
    )
    rsv = next(
        record
        for record in records
        if record.disease is Disease.RSV
        and record.observation_end == date(2026, 7, 25)
    )
    assert rsv.value == 0.8
    assert QualityFlag.SPARSE in rsv.quality_flags
    assert rsv.metadata["tests_3wma"] is None
    assert rsv.metadata["tests_suppressed"] is True
    assert rsv.metadata["latest_week_uses_partial_centered_window"] is True


def test_nrevss_skips_unavailable_primary_values_without_fabricating_zero() -> None:
    row = dict(load_json_fixture("nrevss_ma.json")[0])
    row["percent_pos_3wma"] = "."
    connector = NrevssConnector()

    records = connector.normalize(
        connector.parse_json([row]), retrieved_at=RETRIEVED_AT
    )

    assert records == []


@pytest.mark.parametrize("marker", ["*", "."])
def test_nrevss_accepts_documented_suppression_and_missing_markers(
    marker: str,
) -> None:
    row = dict(load_json_fixture("nrevss_ma.json")[1])
    row["tests_3wma"] = marker
    parsed = NrevssConnector().parse_json([row])[0]

    assert parsed.tests_3wma is None
    assert parsed.tests_suppressed is (marker == "*")


@pytest.mark.parametrize(
    ("field", "value", "message"),
    [
        ("level", "HHS Region", "state-level"),
        ("state", "NY", "outside Massachusetts"),
        ("pathogen", "Influenza", "unsupported"),
        ("mmwrweek_end", "2026-07-24", "Saturday"),
        ("posted", "2026-07-01", "must not precede"),
        ("percent_pos_3wma", "101", "between 0 and 100"),
        ("tests_3wma", "-1", "nonnegative"),
    ],
)
def test_nrevss_rejects_rows_outside_the_reviewed_contract(
    field: str, value: str, message: str
) -> None:
    row = dict(load_json_fixture("nrevss_ma.json")[1])
    row[field] = value

    with pytest.raises(SourceSchemaError, match=message):
        NrevssConnector().parse_json([row])


def test_nrevss_request_is_pinned_to_reviewed_state_pathogens() -> None:
    parameters = NrevssConnector.request_parameters
    assert "level='State'" in parameters["$where"]
    assert "state='MA'" in parameters["$where"]
    assert "'RSV','SARS-COV-2'" in parameters["$where"]


def test_nrevss_rejects_nonnumeric_objects_as_schema_errors() -> None:
    row = dict(load_json_fixture("nrevss_ma.json")[1])
    row["tests_3wma"] = {"unexpected": "object"}

    with pytest.raises(SourceSchemaError, match="must be numeric"):
        NrevssConnector().parse_json([row])
