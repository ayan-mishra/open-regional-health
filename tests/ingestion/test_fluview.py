from datetime import UTC, date, datetime

import pytest
from corvid.ingestion.base import SourceSchemaError
from corvid.ingestion.fluview import FluViewConnector
from corvid.normalization.observations import mmwr_week_interval

from tests.ingestion.conftest import load_json_fixture

RETRIEVED_AT = datetime(2026, 7, 25, 10, 32, 8, tzinfo=UTC)


def test_fluview_records_the_publishers_public_reuse_classification() -> None:
    source = FluViewConnector.source
    assert source.license_name == "Publicly Accessible US Government"
    assert source.allowed_use == "research_and_commercial"


def test_fluview_preserves_vintages_and_distinct_ili_metrics() -> None:
    connector = FluViewConnector()
    rows = connector.parse_json(load_json_fixture("fluview_ma.json"))
    records = connector.normalize(rows, retrieved_at=RETRIEVED_AT)

    assert len(records) == 4
    assert {record.issue_date for record in records} == {
        date(2026, 6, 5),
        date(2026, 7, 24),
    }
    assert {record.metric for record in records} == {
        "ili_percent",
        "weighted_ili_percent",
    }
    assert records[0].metadata["num_age_0"] is None


def test_mmwr_week_conversion_is_sunday_through_saturday() -> None:
    assert mmwr_week_interval(202620) == (date(2026, 5, 17), date(2026, 5, 23))


def test_mmwr_week_conversion_uses_the_week_containing_january_fourth() -> None:
    assert mmwr_week_interval(202553) == (date(2025, 12, 28), date(2026, 1, 3))
    assert mmwr_week_interval(202601) == (date(2026, 1, 4), date(2026, 1, 10))
    with pytest.raises(SourceSchemaError, match="exceeds"):
        mmwr_week_interval(202554)


@pytest.mark.parametrize(
    "field", ["num_ili", "num_patients", "num_providers", "num_age_3"]
)
def test_fluview_rejects_negative_count_fields(field: str) -> None:
    row = dict(load_json_fixture("fluview_ma.json")["epidata"][0])
    row[field] = -1

    with pytest.raises(SourceSchemaError, match="nonnegative"):
        FluViewConnector().parse_json({"result": 1, "epidata": [row]})
